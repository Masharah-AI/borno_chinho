import json
import base64
import uvicorn
from typing import List
from contextlib import asynccontextmanager
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware
from fastapi import FastAPI, File, UploadFile, HTTPException, Request

from services.supervisor import Supervisor
from logger import setup_logging, get_logger
from config import HOST, PORT

setup_logging()
logger = get_logger("app")


@asynccontextmanager
async def lifespan(app:FastAPI):

    logger.info("Application started.")

    yield

    logger.info("Application stopped.")
    

app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory="static"), name="static")

templates = Jinja2Templates(directory="templates")

@app.get("/", response_class=HTMLResponse)
async def root(request: Request):

    return templates.TemplateResponse(request, "index.html")


@app.post("/upload_image")
async def upload_image(uploaded_file: UploadFile=File(...)):

    if not uploaded_file.content_type.startswith("image/"):
        logger.warning(f"Image upload rejected: '{uploaded_file.filename}' has unsupported type '{uploaded_file.content_type}'.")
        raise HTTPException(
            status_code=415,
            detail="Unsupported file type."
        )

    content = await uploaded_file.read()

    image_name = uploaded_file.filename

    image_content = base64.b64encode(content).decode("utf-8")

    return {
        "name": image_name,
        "content": image_content
    }
    
@app.post("/upload_json")
async def upload_json(uploaded_file: UploadFile=File(...)):
    
    if not uploaded_file.content_type.endswith("json"):
        logger.warning(f"Json upload rejected: '{uploaded_file.filename}' has unsupported type '{uploaded_file.content_type}'.")
        raise HTTPException(
            status_code=415,
            detail="Unsupported file type."
        )

    content = await uploaded_file.read()

    json_name = uploaded_file.filename

    try:
        json_content = json.loads(content.decode("utf-8"))

    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        logger.warning(f"Json upload rejected: '{json_name}' could not be parsed: {e}")
        raise HTTPException(
            status_code=400,
            detail="Malformed json file."
        )

    return {
        "name": json_name,
        "content": json_content
    }


PREVIEW_LENGTH = 90


def make_preview(entry: dict):
    """A short, single-line excerpt identifying the entry to a human.

    The full text is deliberately not returned: a page-long Text entry is what
    made the old error dialog unreadable. This is only a landmark for finding
    the entry in the editor.
    """

    text = entry.get("text")
    if not isinstance(text, str):
        return ""

    preview = " ".join(text.split())
    if len(preview) > PREVIEW_LENGTH:
        preview = preview[:PREVIEW_LENGTH].rstrip() + "…"

    return preview


def describe_entry(index: int, entry: dict, problems: List[str]):
    """One structured error, carrying enough for the UI to render it fully."""

    category = entry.get("category")

    return {
        "index": index,
        "category": category if isinstance(category, str) else None,
        "problems": problems,
        "preview": make_preview(entry)
    }


@app.post("/validate_json")
async def validate_json(data: List[dict]):

    supervisor = Supervisor()

    all_errors = []
    for index, entry in enumerate(data):
        try:
            missing, extra = supervisor.diff_schema(entry=entry)
            if missing or extra:
                problems = []
                if missing:
                    problems.append(f"missing required key(s): {', '.join(missing)}.")
                if extra:
                    problems.append(f"unexpected key(s): {', '.join(extra)}.")
                all_errors.append(describe_entry(index, entry, problems))
                continue

            if not supervisor.validate_category(category=entry["category"]):
                all_errors.append(describe_entry(index, entry, [
                    f"\"{entry['category']}\" is not a known category."
                ]))
                continue

            # Every category carries a bbox, so the geometry check is the same
            # for all of them.
            problems = supervisor.diff_bbox(bbox=entry["bbox"])
            if problems:
                all_errors.append(describe_entry(index, entry, problems))

        except Exception:
            logger.exception(f"Validation failed on entry {index}.")
            raise HTTPException(
                status_code=500,
                detail="Unknown error has occured while validating json."
            )

    logger.info(f"Validated {len(data)} entries, found {len(all_errors)} errors.")

    return {
        "error_count": len(all_errors),
        "error_detail": all_errors
    }


@app.post("/validate_json_dev")
async def validate_json_dev(data: List[dict]):

    supervisor = Supervisor()
    for entry in data:
        if entry["category"]!="Table":
            continue

        errors = supervisor.validate_table_style(table_content=entry["text"])
        if len(errors)>0:
            logger.info(f"Table style errors: {errors}")

    return {"status": "All OK"}



if __name__ == "__main__":
    logger.info("\n\n")

    uvicorn.run("app:app", 
                host=HOST, 
                port=PORT, 
                reload=True
            )
