"""cronjob tool — Agent tool for managing cron jobs."""

import json
import logging
from datetime import datetime, timezone, timedelta

from app.db.database import get_session_factory
from app.dao.cron_dao import CronDAO
from app.agent.llm_router import LLMRouter
from app.config import settings

log = logging.getLogger(__name__)

BEIJING_TZ = timezone(timedelta(hours=8))

TOOL_DEFS = [
    {
        "type": "function",
        "function": {
            "name": "cronjob",
            "description": (
                "Manage scheduled (cron) tasks. Create, list, pause, resume, or remove jobs that "
                "run automatically on a cron schedule. Results are delivered as in-app notifications (站内信). "
                "Use 'create' to set up a recurring or one-shot task, 'list' to view all jobs, "
                "and 'pause/resume/remove/update' to manage them."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["create", "list", "pause", "resume", "remove", "update"],
                        "description": "Action to perform on cron jobs",
                    },
                    "name": {
                        "type": "string",
                        "description": "Job name (required for create; identifier for update/remove/pause/resume)",
                    },
                    "prompt": {
                        "type": "string",
                        "description": "The prompt/instruction the agent will execute when the cron job runs (required for create)",
                    },
                    "schedule": {
                        "type": "string",
                        "description": (
                            "Natural language description of the schedule. "
                            "Describe when the job should run in plain language. "
                            "Examples: 'every day at 9am', 'every Monday at 10:30', "
                            "'every 30 minutes', 'every weekday at 8am', "
                            "'first day of every month at 9am', '15th of every month at 2pm', "
                            "'every Monday and Wednesday at 10am', "
                            "'every 2 hours', 'today at 3pm', 'every hour at minute 30'. "
                            "The backend will convert this to a precise cron expression."
                        ),
                    },
                },
                "required": ["action"],
            },
        },
    },
]


async def _schedule_to_cron(schedule: str) -> str:
    """Convert a natural language schedule description to a cron expression via LLM."""
    now = datetime.now(BEIJING_TZ)
    today_info = (
        f"Today's date: {now.strftime('%Y-%m-%d')} (day={now.day}, month={now.month}, "
        f"weekday={now.strftime('%A')}, weekday_number={now.isoweekday()})\n"
        f"Current time: {now.strftime('%H:%M')}"
    )

    system_prompt = (
        "You are a cron expression generator. Convert the user's natural language schedule "
        "description into a valid 5-field cron expression.\n\n"
        "CRON FORMAT: 'minute hour day month weekday'\n"
        "- minute: 0-59\n"
        "- hour: 0-23\n"
        "- day: 1-31\n"
        "- month: 1-12\n"
        "- weekday: 0-7 (0 and 7 both = Sunday, 1 = Monday, ..., 6 = Saturday)\n\n"
        "RULES:\n"
        "1. If the user says 'today' or specifies a specific date, use THAT EXACT day/month "
        "(one-shot, runs only once). E.g. 'today at 3pm' on June 2 → '0 15 2 6 *'\n"
        "2. If the user says 'every day', 'daily', 'every Monday', 'every month', etc., "
        "use '*' or specific values for recurring execution.\n"
        "3. Common patterns:\n"
        "   - 'every day at 9am' → '0 9 * * *'\n"
        "   - 'every Monday at 10am' → '0 10 * * 1'\n"
        "   - 'every weekday at 9am' → '0 9 * * 1-5'\n"
        "   - 'every weekend at 8am' → '0 8 * * 0,6'\n"
        "   - 'every 30 minutes' → '*/30 * * * *'\n"
        "   - 'every 5 minutes' → '*/5 * * * *'\n"
        "   - 'every hour' → '0 * * * *'\n"
        "   - 'every hour at minute 30' → '30 * * * *'\n"
        "   - 'every 2 hours' → '0 */2 * * *'\n"
        "   - 'every day at 9am and 5pm' → '0 9,17 * * *'\n"
        "   - 'every Monday and Wednesday at 10am' → '0 10 * * 1,3'\n"
        "   - 'every Monday, Wednesday, Friday at 9am' → '0 9 * * 1,3,5'\n"
        "   - 'first day of every month at 9am' → '0 9 1 * *'\n"
        "   - '15th of every month at 2pm' → '0 14 15 * *'\n"
        "   - 'last day of every month at 9am' → '0 9 28-31 * *' (closest approximation)\n"
        "   - 'every day at midnight' → '0 0 * * *'\n"
        "   - 'every Monday at 8am and 6pm' → '0 8,18 * * 1'\n"
        "   - 'every 3 hours starting at 1am' → '0 1,4,7,10,13,16,19,22 * * *'\n"
        "4. For 'every N hours starting at H', expand into explicit hour list.\n"
        "5. For 'today' or specific dates, use the actual day/month values from the provided date info.\n"
        "6. Use '*/N' for evenly-spaced intervals only when the starting point doesn't matter.\n\n"
        f"{today_info}\n\n"
        "OUTPUT: Return ONLY the cron expression as a single line, nothing else. "
        "No explanation, no markdown, no quotes."
    )

    router = LLMRouter()
    response = await router.chat(
        model=settings.compress_model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": schedule},
        ],
        stream=False,
        use_compress=True,
    )
    cron_expr = response.choices[0].message.content.strip()
    # Remove any surrounding quotes or backticks the LLM might add
    cron_expr = cron_expr.strip("'\"`")
    log.info("Schedule '%s' - cron '%s'", schedule, cron_expr)
    return cron_expr


async def cronjob(args_str: str, employee_id: int) -> str:
    args = json.loads(args_str)
    action = args.get("action", "")
    name = args.get("name", "")
    prompt = args.get("prompt", "")
    schedule = args.get("schedule", "")

    dao = CronDAO(get_session_factory(), employee_id)

    try:
        if action == "create":
            if not prompt:
                return json.dumps({"error": "prompt is required for create"}, ensure_ascii=False)
            if not schedule:
                return json.dumps({"error": "schedule is required for create (natural language, e.g. 'every day at 9am')"}, ensure_ascii=False)

            cron_expr = await _schedule_to_cron(schedule)
            from croniter import croniter
            try:
                croniter(cron_expr)
            except ValueError as e:
                return json.dumps({"error": f"Failed to generate valid cron from schedule '{schedule}': {e}. Generated: '{cron_expr}'"}, ensure_ascii=False)

            job = await dao.create(name=name, prompt=prompt, cron_expr=cron_expr)
            return json.dumps({
                "id": job.id,
                "name": job.name,
                "cron_expr": job.cron_expr,
                "next_run_at": job.next_run_at,
                "message": f"Cron job '{job.name}' created. Results will be delivered as notifications (站内信).",
            }, ensure_ascii=False)

        elif action == "list":
            jobs = await dao.list_jobs()
            job_list = [
                {
                    "id": j.id,
                    "name": j.name,
                    "cron_expr": j.cron_expr,
                    "is_active": j.is_active,
                    "next_run_at": j.next_run_at,
                    "run_count": j.run_count,
                }
                for j in jobs
            ]
            return json.dumps({"jobs": job_list, "count": len(job_list)}, ensure_ascii=False)

        elif action == "pause":
            job = await dao.get_by_name(name) if name else None
            if not job:
                return json.dumps({"error": f"Job '{name}' not found"}, ensure_ascii=False)
            paused = await dao.pause(job.id)
            return json.dumps({"id": paused.id, "is_active": paused.is_active, "message": f"Job '{paused.name}' paused"}, ensure_ascii=False)

        elif action == "resume":
            job = await dao.get_by_name(name) if name else None
            if not job:
                return json.dumps({"error": f"Job '{name}' not found"}, ensure_ascii=False)
            resumed = await dao.resume(job.id)
            return json.dumps({"id": resumed.id, "is_active": resumed.is_active, "next_run_at": resumed.next_run_at, "message": f"Job '{resumed.name}' resumed"}, ensure_ascii=False)

        elif action == "remove":
            job = await dao.get_by_name(name) if name else None
            if not job:
                return json.dumps({"error": f"Job '{name}' not found"}, ensure_ascii=False)
            await dao.soft_delete(job.id)
            return json.dumps({"id": job.id, "message": f"Job '{job.name}' removed"}, ensure_ascii=False)

        elif action == "update":
            job = await dao.get_by_name(name) if name else None
            if not job:
                return json.dumps({"error": f"Job '{name}' not found"}, ensure_ascii=False)
            kwargs = {}
            if prompt:
                kwargs["prompt"] = prompt
            if schedule:
                cron_expr = await _schedule_to_cron(schedule)
                from croniter import croniter
                try:
                    croniter(cron_expr)
                except ValueError as e:
                    return json.dumps({"error": f"Failed to generate valid cron from schedule '{schedule}': {e}. Generated: '{cron_expr}'"}, ensure_ascii=False)
                kwargs["cron_expr"] = cron_expr
            if args.get("new_name"):
                kwargs["name"] = args.get("new_name")
            if not kwargs:
                return json.dumps({"error": "No fields to update"}, ensure_ascii=False)
            updated = await dao.update(job.id, **kwargs)
            return json.dumps({"id": updated.id, "name": updated.name, "cron_expr": updated.cron_expr, "message": f"Job '{updated.name}' updated"}, ensure_ascii=False)

        else:
            return json.dumps({"error": f"Unknown action: {action}"}, ensure_ascii=False)

    except Exception as e:
        return json.dumps({"error": f"Cron job operation failed: {e}"}, ensure_ascii=False)