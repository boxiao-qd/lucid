from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from app.responses import UnicodeJSONResponse
from app.auth.jwt_utils import decode_access_token

_PUBLIC_PREFIXES = ("/auth/", "/v1/internal/", "/v1/files/attachment")
_PROTECTED_PREFIXES = ("/v1/",)


def _strip_root_path(path: str, scope: dict) -> str:
    """Remove root_path prefix so middleware checks work regardless of proxy config."""
    root = scope.get("root_path", "").rstrip("/")
    if root and path.startswith(root):
        stripped = path[len(root):]
        return stripped if stripped.startswith("/") else "/" + stripped
    return path


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = _strip_root_path(request.url.path, request.scope)

        # Public paths: auth endpoints and OPTIONS preflight — skip JWT check
        if request.method == "OPTIONS" or any(path.startswith(p) for p in _PUBLIC_PREFIXES):
            request.state.employee_id = 0
            return await call_next(request)

        # Protected paths: require Bearer token
        if any(path.startswith(p) for p in _PROTECTED_PREFIXES):
            auth_header = request.headers.get("Authorization", "")
            token = auth_header.removeprefix("Bearer ").strip() if auth_header.startswith("Bearer ") else ""
            if not token:
                return UnicodeJSONResponse(
                    status_code=401,
                    content={"error_code": "BX_AUTH_1001", "message": "Authorization header required"},
                )
            employee_id = decode_access_token(token)
            if not employee_id:
                return UnicodeJSONResponse(
                    status_code=401,
                    content={"error_code": "BX_AUTH_1002", "message": "Invalid or expired token"},
                )
            request.state.employee_id = employee_id
            return await call_next(request)

        request.state.employee_id = 0
        return await call_next(request)
