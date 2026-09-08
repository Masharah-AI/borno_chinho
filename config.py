import os

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))

LOG_DIR = os.path.join(ROOT_DIR, "logs")

LOG_FILE = "app.log"
LOG_LEVEL = "INFO"
LOG_MAX_BYTES = 5 * 1024 * 1024
LOG_BACKUP_COUNT = 3

HOST = "0.0.0.0"

PORT = 2828

# Root of the server-side dataset browsed by the "Server" mount buttons.
# Override with BORNO_DATA_DIR when the dataset lives elsewhere.
DATA_DIR = os.environ.get("BORNO_DATA_DIR", "/data/masharah_dataset/dataset")

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}

PICTURE_SCHEMA = [
    "bbox", 
    "category"
]

TABLE_SCHEMA = [
    "bbox", 
    "category", 
    "text"
]

OVERALL_SCHEMA = [
    "bbox", 
    "category", 
    "text"
]

CATEGORIES = [
    "Picture",
    "Title",
    "Page-header",
    "Section-header",
    "Text",
    "List-item",
    "Table",
    "Caption",
    "Footnote",
    "Page-footer"
]

FONT_SIZES = {
    "Title": '17',
    "Page-header": '12',
    "Section-header": '12',
    "Text": '11',
    "List-item": '11',
    "Table": '11',
    "Caption": '10',
    "Footnote": '9',
    "Page-footer": '9'
}


FONT_STYLES = [
    "normal",
    "bold",
    "italic",
    "underline"
]

ALIGNMENTS = [
    "left",
    "center",
    "right",
    "justify"
]


CSS_STYLES = {
    "font-size": ["11px"],
    "font-weight": ["normal", "bold"],
    "font-style": ["normal", "italic"],
    "text-decoration": ["none"],
    "text-align": ["left", "right", "center", "justify"]
}