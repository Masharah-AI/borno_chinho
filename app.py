import os
import json
import base64
import shutil
import uvicorn
from typing import List
from pathlib import Path
from pydantic import BaseModel
from contextlib import asynccontextmanager
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware
from fastapi import FastAPI, File, UploadFile, HTTPException, Request

from services.supervisor import Supervisor
from logger import setup_logging, get_logger
from config import HOST, PORT, CATEGORIES, DATA_DIR, IMAGE_EXTENSIONS

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


# ---------------------------------------------------------------------------
# Server-side dataset access
# Lets the frontend browse, read and write files under DATA_DIR on the host,
# so annotators can work on the shared dataset without copying it to their own
# machine first. Every path from the client is resolved against DATA_DIR and
# rejected if it escapes it; only .json files can be written back.
# ---------------------------------------------------------------------------

# Shadow tree holding a copy of each annotation file as it was before its
# first edit through this tool, so a bad save never destroys the only copy.
BACKUP_DIR_NAME = ".borno_backups"


def data_root():

    root = Path(DATA_DIR).resolve()
    if not root.is_dir():
        logger.error(f"Server data directory is not available: {DATA_DIR}")
        raise HTTPException(
            status_code=503,
            detail=f"Server data directory is not available: {DATA_DIR}"
        )
    return root


def resolve_data_path(rel_path: str):
    """The absolute path for a client-supplied one, confined to DATA_DIR."""

    root = data_root()
    candidate = (root / rel_path.lstrip("/")).resolve()

    if candidate != root and root not in candidate.parents:
        logger.warning(f"Rejected path outside the data directory: '{rel_path}'.")
        raise HTTPException(
            status_code=400,
            detail="Path escapes the server data directory."
        )
    return root, candidate


@app.get("/server/browse")
async def server_browse(path: str = ""):
    """The immediate subfolders of one dataset folder, plus how many image
    and annotation files sit directly in it, for the folder picker."""

    root, directory = resolve_data_path(path)
    if not directory.is_dir():
        raise HTTPException(status_code=404, detail="No such folder on the server.")

    dirs = []
    image_count = 0
    json_count = 0
    for entry in os.scandir(directory):
        if entry.name.startswith("."):
            continue
        if entry.is_dir():
            dirs.append(entry.name)
        elif entry.is_file():
            ext = os.path.splitext(entry.name)[1].lower()
            if ext in IMAGE_EXTENSIONS:
                image_count += 1
            elif ext == ".json":
                json_count += 1

    dirs.sort()
    rel = "" if directory == root else str(directory.relative_to(root))

    return {
        "path": rel,
        "dirs": dirs,
        "image_count": image_count,
        "json_count": json_count
    }


@app.get("/server/files")
async def server_files(path: str = "", kind: str = "images"):

    if kind not in ("images", "json"):
        raise HTTPException(status_code=400, detail="kind must be 'images' or 'json'.")

    root, directory = resolve_data_path(path)
    if not directory.is_dir():
        raise HTTPException(status_code=404, detail="No such folder on the server.")

    extensions = IMAGE_EXTENSIONS if kind == "images" else {".json"}
    files = [
        entry.name for entry in os.scandir(directory)
        if entry.is_file()
        and not entry.name.startswith(".")
        and os.path.splitext(entry.name)[1].lower() in extensions
    ]
    files.sort()

    rel = "" if directory == root else str(directory.relative_to(root))

    return {"path": rel, "files": files}


@app.get("/server/file")
async def server_file(path: str):

    root, file_path = resolve_data_path(path)
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="No such file on the server.")

    return FileResponse(file_path)


class ServerSaveRequest(BaseModel):
    path: str
    text: str


@app.post("/server/save")
async def server_save(request: ServerSaveRequest):

    root, file_path = resolve_data_path(request.path)

    if file_path.suffix.lower() != ".json":
        raise HTTPException(
            status_code=400,
            detail="Only .json files can be written to the server."
        )
    if not file_path.parent.is_dir():
        raise HTTPException(
            status_code=404,
            detail="The folder for that file does not exist on the server."
        )

    try:
        json.loads(request.text)
    except json.JSONDecodeError as e:
        logger.warning(f"Server save rejected: '{request.path}' is not valid json: {e}")
        raise HTTPException(status_code=400, detail="Malformed json content.")

    rel = file_path.relative_to(root)

    if file_path.exists():
        backup_path = root / BACKUP_DIR_NAME / rel
        if not backup_path.exists():
            backup_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(file_path, backup_path)

    # Write-then-rename, so a crash mid-write cannot leave a truncated file.
    tmp_path = file_path.with_name(file_path.name + ".tmp~")
    try:
        tmp_path.write_text(request.text, encoding="utf-8")
        os.replace(tmp_path, file_path)
    except OSError as e:
        tmp_path.unlink(missing_ok=True)
        logger.exception(f"Server save failed for '{request.path}'.")
        raise HTTPException(status_code=500, detail=f"Could not write the file: {e}")

    logger.info(f"Saved '{rel}' to the server dataset.")

    return {"status": "saved", "path": str(rel)}


PREVIEW_LENGTH = 90

# What each field IS, for messages aimed at whoever is fixing the file. The
# literal name is kept alongside the description so the field stays findable
# in the editor.
FIELD_LABELS = {
    "bbox": "the bounding box (bbox)",
    "category": "the category (category)",
    "text": "the text content (text)"
}


def label_field(field: str):

    return FIELD_LABELS.get(field, f'"{field}"')


def join_fields(fields: List[str]):
    """Field descriptions as readable prose: "a, b and c"."""

    labels = [label_field(field) for field in fields]

    if len(labels) == 1:
        return labels[0]

    return ", ".join(labels[:-1]) + " and " + labels[-1]


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
                    one = len(missing) == 1
                    problems.append(
                        f"Missing {'field' if one else 'fields'}: this entry needs "
                        f"{join_fields(missing)}, but "
                        f"{'it is' if one else 'they are'} not there."
                    )
                if extra:
                    one = len(extra) == 1
                    category = entry.get("category")
                    belongs = f"a {category} entry" if isinstance(category, str) else "this entry"
                    problems.append(
                        f"Unexpected {'field' if one else 'fields'}: "
                        f"{join_fields(extra)} "
                        f"{'does' if one else 'do'} not belong in {belongs}, so "
                        f"{'it' if one else 'they'} should be removed."
                    )
                all_errors.append(describe_entry(index, entry, problems))
                continue

            if not supervisor.validate_category(category=entry["category"]):
                all_errors.append(describe_entry(index, entry, [
                    f"Unknown category: \"{entry['category']}\" is not a category "
                    "this tool recognises.",
                    "Valid categories are: " + ", ".join(CATEGORIES) + "."
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
