from config import *
from services.html_parser import HTMLParser

class Supervisor:

    def __init__(self):
        self.picture_schema = PICTURE_SCHEMA
        self.table_schema = TABLE_SCHEMA
        self.overall_schema = OVERALL_SCHEMA
        self.categories = CATEGORIES
        self.font_sizes = FONT_SIZES
        self.font_styles = FONT_STYLES
        self.alignments = ALIGNMENTS
        self.css_styles = CSS_STYLES

        self.html_parser = HTMLParser()

    
    def validate_schema(self, entry: dict):

        missing, extra = self.diff_schema(entry=entry)

        return len(missing) == 0 and len(extra) == 0


    def diff_schema(self, entry: dict):
        """Which keys the entry is missing, and which it has that it should not.

        Returned instead of a bare bool so the caller can say *what* is wrong
        rather than only that something is.
        """

        if "category" not in entry.keys():
            return ["category"], []

        schema = None
        if entry["category"] == "Picture":
            schema = self.picture_schema
        elif entry["category"] == "Table":
            schema = self.table_schema
        else:
            schema = self.overall_schema

        available_schema = set(entry.keys())
        required_schema = set(schema)

        missing = sorted(required_schema.difference(available_schema))
        extra = sorted(available_schema.difference(required_schema))

        return missing, extra


    def validate_bbox(self, bbox: list):

        return len(self.diff_bbox(bbox=bbox)) == 0


    def diff_bbox(self, bbox: list):
        """The bbox rules this box breaks, phrased for the person reading them.

        Each reason is a complete sentence naming the offending numbers, so the
        UI can show it without knowing anything about the rules.
        """

        if not isinstance(bbox, list):
            return ["bbox must be a list of four numbers."]

        if len(bbox) != 4:
            return [f"bbox needs exactly 4 numbers, but has {len(bbox)}."]

        try:
            coords = [int(coord) for coord in bbox]
        except (TypeError, ValueError):
            return [f"bbox must hold four numbers, but is {bbox}."]

        reasons = []

        negative = [str(coord) for coord in coords if coord <= 0]
        if negative:
            reasons.append(
                f"coordinates must be positive, but found {', '.join(negative)}."
            )

        x1, y1, x2, y2 = coords
        if x1 > x2:
            reasons.append(f"left edge ({x1}) is right of the right edge ({x2}).")
        if y1 > y2:
            reasons.append(f"top edge ({y1}) is below the bottom edge ({y2}).")

        return reasons


    def validate_category(self, category: str):

        return category in self.categories
    

    def validate_font_size(self, entry: dict):

        if entry["category"] in ["Picture", "Table"]:
            return True

        return self.font_sizes[entry["category"]] == entry["font_size"]
    

    def validate_font_style(self, font_style: list):

        for style in font_style:
            if style not in self.font_styles:
                return False
            
        return True
    

    def validate_alignment(self, alignment: str):

        return alignment in self.alignments
    

    def validate_css_properties(self, css_style: dict):

        expected_properties = list(self.css_styles.keys())
        available_properties = list(css_style.keys())

        if not sorted(expected_properties) == sorted(available_properties):
            expected_properties = set(expected_properties)
            available_properties = set(available_properties)
            missing_properties = expected_properties.difference(available_properties)
            extra_properties = available_properties.difference(expected_properties)
            return list(missing_properties), list(extra_properties)
        
        return [],[]
    

    def validate_css_style(self, css_style):

        for key, val in self.css_styles.items():
            if css_style[key] not in val:
                return False

        return True
    

    def validate_table_style(self, table_content):

        tags = self.html_parser.get_html_tags(table_content)

        errors = []
        for tag in tags:
            css_style = self.html_parser.get_css_properties(tag)

            missing_properties, extra_properties = self.validate_css_properties(css_style=css_style)
            if len(missing_properties)>0: errors.append(f"Missing CSS properties: {missing_properties}")
            if len(extra_properties)>0: errors.append(f"Extra CSS properties: {extra_properties}")

        return errors