"""skills tool — list, view, and manage skills (aligns with Hermes skills_list/skill_view/skill_manage)."""

import json

from app.db.database import get_session_factory
from app.dao.skill_dao import SkillDAO
from app.storage.sys_infra import list_system_skills, get_system_skill_md


def _extract_frontmatter_text(content_md: str) -> str | None:
    """Extract raw YAML frontmatter text from SKILL.md content."""
    stripped = content_md.strip()
    if not stripped.startswith("---"):
        return None
    parts = stripped.split("---", 2)
    if len(parts) < 3:
        return None
    text = parts[1].strip()
    return text if text else None


def _extract_header(content_md: str) -> str:
    """Extract description from SKILL.md frontmatter, falling back to first body line."""
    import yaml
    stripped = content_md.strip()
    if stripped.startswith("---"):
        parts = stripped.split("---", 2)
        if len(parts) >= 3:
            try:
                fm = yaml.safe_load(parts[1])
                if isinstance(fm, dict):
                    desc = fm.get("description")
                    if isinstance(desc, str) and desc.strip():
                        return " ".join(desc.split())[:500]
            except yaml.YAMLError:
                pass
            body = parts[2]
        else:
            body = stripped
    else:
        body = stripped
    for line in body.splitlines():
        line = line.strip().lstrip("#").strip()
        if line and line != "---":
            return line[:500]
    return ""


TOOL_DEFS = [
    {
        "type": "function",
        "function": {
            "name": "skills_list",
            "description": (
                "List available skills (name + description). Use skill_view(name) to load full content. "
                "Skills are reusable instruction documents that give the agent specialized knowledge."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "scope": {
                        "type": "string",
                        "enum": ["all", "global", "personal"],
                        "default": "all",
                        "description": "Filter by scope: 'global' (shared), 'personal' (user-specific), or 'all'",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "skill_view",
            "description": (
                "Load a skill's full content by name. Returns markdown content + available remote assets "
                "(scripts/references/assets) listing. Progressive disclosure: "
                "use skills_list first, then skill_view for detailed content. "
                "If assets exist, use skill_asset_pull to fetch them from remote storage."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Skill name to load",
                    },
                },
                "required": ["name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "skill_manage",
            "description": (
                "Update or delete a PERSONAL skill. "
                "IMPORTANT: Do NOT use action=create to create new skills — always use the /skill-creator skill workflow instead, "
                "which ensures proper frontmatter, structure, and storage in MySQL + MinIO. "
                "Use this tool ONLY for action=update (modify existing skill content) or action=delete."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["create", "update", "delete"],
                        "description": "Action to perform",
                    },
                    "name": {
                        "type": "string",
                        "description": "Skill name (1-64 chars, required for create; identifier for update/delete)",
                    },
                    "content_md": {
                        "type": "string",
                        "description": "Skill content in markdown format (required for create, optional for update)",
                    },
                    "is_global": {
                        "type": "boolean",
                        "default": False,
                        "description": "Whether this skill is shared globally. ALWAYS false for regular users — only admins can create global skills.",
                    },
                },
                "required": ["action", "name"],
            },
        },
    },
]


async def skills_list(args_str: str, employee_id: int) -> str:
    args = json.loads(args_str)
    scope = args.get("scope", "all")

    # System skills from container filesystem
    sys_skills = list_system_skills()  # [{name, description, is_global: True}]
    sys_names = {s["name"] for s in sys_skills}

    # User custom skills from DB (exclude names already covered by sys-infra)
    session_factory = get_session_factory()
    dao = SkillDAO(session_factory, employee_id)
    try:
        db_index = await dao.get_index()
    except Exception as e:
        return json.dumps({"error": f"Failed to list skills: {e}"}, ensure_ascii=False)

    user_skills = [s for s in db_index if s["name"] not in sys_names and not s["is_global"]]

    all_skills = sys_skills + user_skills

    if scope == "global":
        all_skills = [s for s in all_skills if s["is_global"]]
    elif scope == "personal":
        all_skills = [s for s in all_skills if not s["is_global"]]

    return json.dumps({
        "skills": [{"name": s["name"], "description": s["description"], "is_global": bool(s["is_global"])} for s in all_skills],
        "count": len(all_skills),
        "scope": scope,
        "hint": "Use skill_view(name) to load full content.",
    }, ensure_ascii=False)


async def skill_view(args_str: str, employee_id: int) -> str:
    args = json.loads(args_str)
    name = args.get("name", "")

    # Check sys-infra first (system skills take precedence)
    sys_md = get_system_skill_md(name)
    if sys_md is not None:
        return json.dumps({
            "name": name,
            "content_md": sys_md,
            "is_global": True,
        }, ensure_ascii=False)

    session_factory = get_session_factory()
    dao = SkillDAO(session_factory, employee_id)

    try:
        skill = await dao.get_by_name(name)
        if not skill:
            return json.dumps({"error": f"Skill '{name}' not found"}, ensure_ascii=False)

        # L2: load full SKILL.md — cache → MySQL content_md → object storage (legacy fallback)
        content_md = await dao.get_skill_md(name)
        await dao.increment_usage(skill.id)

        # L3: scan remote assets (scripts/references/assets) if object_key exists
        assets = None
        if skill.object_key:
            try:
                from app.storage.object_storage import create_object_storage
                storage = create_object_storage()
                obj_key = skill.object_key
                scripts = await storage.list_directory(employee_id, f"{obj_key}/scripts")
                references = await storage.list_directory(employee_id, f"{obj_key}/references")
                assets_files = await storage.list_directory(employee_id, f"{obj_key}/assets")
                assets = {
                    "scripts": scripts,
                    "references": references,
                    "assets": assets_files,
                }
            except Exception as e:
                assets = {"error": f"Failed to list remote assets: {e}"}

        return json.dumps({
            "name": skill.name,
            "content_md": content_md or "",
            "is_global": bool(skill.is_global),
            "assets": assets,
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": f"Failed to view skill: {e}"}, ensure_ascii=False)


async def skill_manage(args_str: str, employee_id: int) -> str:
    args = json.loads(args_str)
    action = args.get("action", "")
    name = args.get("name", "")
    content_md = args.get("content_md", "")
    is_global = args.get("is_global", False)

    session_factory = get_session_factory()
    dao = SkillDAO(session_factory, employee_id)

    try:
        if action == "create":
            return json.dumps({
                "error": "Do not use skill_manage to create skills. Use the /skill-creator skill workflow instead — it ensures proper frontmatter, structure, and storage in MySQL + MinIO.",
                "hint": "Invoke /skill-creator to guide the user through proper skill creation.",
            }, ensure_ascii=False)

        elif action == "update":
            skill = await dao.get_by_name(name)
            if not skill:
                return json.dumps({"error": f"Skill '{name}' not found"}, ensure_ascii=False)
            update_data = {}
            if content_md:
                update_data["content_md"] = content_md
                update_data["frontmatter"] = _extract_frontmatter_text(content_md)
                header = _extract_header(content_md)
                if header:
                    update_data["header_description"] = header
            if args.get("new_name"):
                update_data["name"] = args.get("new_name")
            updated = await dao.update(skill.id, **update_data)
            return json.dumps({
                "id": updated.id,
                "name": updated.name,
                "is_global": bool(updated.is_global),
                "message": f"Skill '{name}' updated",
            }, ensure_ascii=False)

        elif action == "delete":
            skill = await dao.get_by_name(name)
            if not skill:
                return json.dumps({"error": f"Skill '{name}' not found"}, ensure_ascii=False)
            await dao.soft_delete(skill.id)
            return json.dumps({
                "name": name,
                "message": f"Skill '{name}' deleted",
            }, ensure_ascii=False)

        else:
            return json.dumps({"error": f"Unknown action: {action}"}, ensure_ascii=False)

    except Exception as e:
        error_msg = str(e)
        if "BX_SKILL_1002" in error_msg:
            return json.dumps({"error": f"Skill name '{name}' already exists"}, ensure_ascii=False)
        if "BX_SKILL_1003" in error_msg:
            return json.dumps({"error": "Non-admin users cannot modify global skills"}, ensure_ascii=False)
        return json.dumps({"error": f"Skill management failed: {e}"}, ensure_ascii=False)