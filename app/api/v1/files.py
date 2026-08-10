"""User files API — list / download / delete files stored in MinIO under user-data/{employee_id}/."""

import logging
import os
import uuid
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import Response, StreamingResponse

from app.config import settings
from app.dao.artifact_file_dao import ArtifactFileDAO
from app.db.database import get_session_factory
from app.dependencies import get_employee_id

router = APIRouter(prefix="/files", tags=["files"])
log = logging.getLogger(__name__)


def _s3_client():
    import boto3

    kw = dict(
        aws_access_key_id=settings.object_storage_access_key,
        aws_secret_access_key=settings.object_storage_secret_key,
        region_name=settings.object_storage_region or "us-east-1",
    )
    if settings.object_storage_endpoint:
        kw["endpoint_url"] = settings.object_storage_endpoint
    return boto3.client("s3", **kw)


@router.post("/upload-image")
async def upload_image(
    file: UploadFile = File(...),
    employee_id: int = Depends(get_employee_id),
):
    """Upload a chat image attachment to MinIO. Returns the public URL."""
    # Validate content type
    ct = file.content_type or ""
    if not ct.startswith("image/"):
        raise HTTPException(status_code=415, detail=f"Only image/* files are accepted, got: {ct}")

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")

    # 10 MB limit
    if len(data) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image too large (max 10 MB)")

    ext = os.path.splitext(file.filename or "")[1].lower() or ".jpg"
    key = f"chat-attachments/{employee_id}/{uuid.uuid4()}{ext}"

    bucket = settings.object_storage_bucket
    try:
        s3 = _s3_client()
        s3.put_object(Bucket=bucket, Key=key, Body=data, ContentType=ct)
    except Exception as e:
        log.error("MinIO upload failed for key %s: %s", key, e)
        raise HTTPException(status_code=502, detail="Failed to upload image to storage")

    # Return a proxy URL (relative) so the browser can access the image
    # through the API without needing public MinIO bucket access.
    # The key contains a UUID and serves as an unguessable capability token.
    proxy_url = f"/bx/api/v1/files/attachment?key={quote(key, safe='')}"

    return {"url": proxy_url, "name": file.filename or "image" + ext, "type": "image"}


@router.get("/attachment")
async def get_attachment(key: str):
    """Serve a chat image from MinIO by key.

    No Bearer auth required — the key contains a UUID and serves as a
    capability token (unguessable). This lets <img src> tags load images
    without custom auth headers.
    """
    # Only allow chat-attachment keys to prevent accessing other MinIO objects
    if not key.startswith("chat-attachments/"):
        raise HTTPException(status_code=403, detail="Invalid attachment key")

    bucket = settings.object_storage_bucket
    try:
        s3 = _s3_client()
        resp = s3.get_object(Bucket=bucket, Key=key)
        data = resp["Body"].read()
        content_type = resp.get("ContentType", "image/jpeg")
    except Exception as e:
        log.warning("Attachment read failed for key %s: %s", key, e)
        raise HTTPException(status_code=404, detail="Attachment not found")

    return Response(content=data, media_type=content_type)


@router.get("")
async def list_files(
    limit: int = 50,
    offset: int = 0,
    employee_id: int = Depends(get_employee_id),
):
    dao = ArtifactFileDAO(get_session_factory(), employee_id)
    files = await dao.list_files(limit=limit, offset=offset)
    total = await dao.count()
    return {
        "files": [
            {
                "id": f.id,
                "file_name": f.file_name,
                "file_size": f.file_size,
                "source_type": f.source_type,
                "source_name": f.source_name,
                "session_id": f.session_id,
                "minio_key": f.minio_key,
                "created_at": f.created_at,
            }
            for f in files
        ],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.get("/{file_id}/download")
async def download_file(
    file_id: str,
    employee_id: int = Depends(get_employee_id),
):
    dao = ArtifactFileDAO(get_session_factory(), employee_id)
    f = await dao.get_by_id(file_id)
    if not f:
        raise HTTPException(status_code=404, detail="File not found")

    bucket = settings.object_storage_bucket

    try:
        s3 = _s3_client()
        resp = s3.get_object(Bucket=bucket, Key=f.minio_key)
        data = resp["Body"].read()
        content_type = resp.get("ContentType", "application/octet-stream")
    except Exception as e:
        log.error("MinIO download failed for key %s: %s", f.minio_key, e)
        raise HTTPException(status_code=502, detail="Failed to retrieve file from storage")

    safe_name = f.file_name.replace('"', "'").replace("\r", "").replace("\n", "")
    encoded_name = quote(safe_name, safe="")
    return Response(
        content=data,
        media_type=content_type,
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{encoded_name}"},
    )


@router.get("/{file_id}/content")
async def get_file_content(
    file_id: str,
    employee_id: int = Depends(get_employee_id),
):
    """Return file content as inline text for preview (text-based files only)."""
    dao = ArtifactFileDAO(get_session_factory(), employee_id)
    f = await dao.get_by_id(file_id)
    if not f:
        raise HTTPException(status_code=404, detail="File not found")

    # Only allow text-based files for inline preview
    ext = os.path.splitext(f.file_name)[1].lower()
    text_extensions = {".md", ".txt", ".py", ".js", ".ts", ".tsx", ".jsx",
                       ".json", ".xml", ".html", ".css", ".yaml", ".yml",
                       ".toml", ".ini", ".cfg", ".sh", ".bat", ".sql",
                       ".csv", ".log", ".env", ".gitignore", ".dockerignore"}
    if ext not in text_extensions:
        raise HTTPException(status_code=415, detail=f"Preview not supported for {ext} files")

    bucket = settings.object_storage_bucket
    try:
        s3 = _s3_client()
        resp = s3.get_object(Bucket=bucket, Key=f.minio_key)
        data = resp["Body"].read()
    except Exception as e:
        log.error("MinIO read failed for key %s: %s", f.minio_key, e)
        raise HTTPException(status_code=502, detail="Failed to retrieve file from storage")

    # Determine content type
    content_type_map = {
        ".md": "text/markdown; charset=utf-8",
        ".html": "text/html; charset=utf-8",
    }
    content_type = content_type_map.get(ext, "text/plain; charset=utf-8")

    return Response(content=data, media_type=content_type)


@router.delete("/{file_id}")
async def delete_file(
    file_id: str,
    employee_id: int = Depends(get_employee_id),
):
    dao = ArtifactFileDAO(get_session_factory(), employee_id)
    f = await dao.get_by_id(file_id)
    if not f:
        raise HTTPException(status_code=404, detail="File not found")

    # Delete from MinIO
    bucket = settings.object_storage_bucket
    try:
        s3 = _s3_client()
        s3.delete_object(Bucket=bucket, Key=f.minio_key)
    except Exception as e:
        log.warning("MinIO delete failed for key %s: %s", f.minio_key, e)
        # Continue to delete DB record even if MinIO object is missing

    # Delete DB record
    await dao.delete_by_id(file_id)
    return {"status": "deleted", "id": file_id}
