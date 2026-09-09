#!/usr/bin/env python3
"""Inventory an untrusted HTML / SPA demo without executing its code.

The mock detector is intentionally heuristic: candidates are evidence for human
review, not extracted facts or a claim that every mock value has been found.
Only the Python standard library is used. Output directories must be new and
outside the input tree; source bytes are copied without decoding or rewriting.
"""

import argparse
import bisect
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys


TEXT_SUFFIXES = {
    ".html", ".htm", ".md", ".markdown", ".txt", ".js", ".jsx",
    ".mjs", ".cjs", ".ts", ".tsx", ".vue", ".svelte", ".json",
    ".css", ".scss", ".sass", ".less", ".yaml", ".yml",
}
CODE_SUFFIXES = {".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".vue", ".svelte", ".html", ".htm"}
DOCUMENT_SUFFIXES = {".md", ".markdown", ".txt", ".html", ".htm"}
STATIC_ASSET_SUFFIXES = {
    ".png", ".jpg", ".jpeg", ".svg", ".ico", ".webp", ".gif", ".avif",
    ".bmp", ".tif", ".tiff", ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".mp4", ".webm", ".mov", ".m4v", ".ogv", ".mp3", ".wav", ".ogg",
    ".flac", ".aac", ".m4a",
}
EXCLUDED_DIRS = {
    ".git", ".hg", ".svn", "node_modules", "bower_components", "vendor",
    ".venv", "venv", "__pycache__", ".next", ".nuxt", ".output",
    ".cache", ".turbo", "coverage", ".pytest_cache",
}
GENERATED_DIRS = {"dist", "build"}
LITERAL_PATTERN = re.compile(
    r"(?:\b(?:const|let|var)\s+[\w$]+(?:\s*:[^=\n;]+)?\s*="
    r"|\b(?:export\s+default|return)\s*|\b[\w$]+\s*:|(?<![=!<>])=(?!=))"
    r"\s*([\[{])"
    r"|\b(?:reactive|ref|shallowRef|useState)\s*\(\s*([\[{])"
)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def decode_text(data):
    """Return text and a visible encoding note; never alter snapshot bytes."""
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        try:
            return data.decode("utf-16"), "utf-16 (BOM)"
        except UnicodeDecodeError:
            pass
    try:
        return data.decode("utf-8-sig"), "utf-8"
    except UnicodeDecodeError:
        try:
            return data.decode("gb18030"), "gb18030 (heuristic fallback)"
        except UnicodeDecodeError:
            return data.decode("utf-8", errors="replace"), "utf-8 (replacement characters)"


def literal_end(text, start):
    """Conservative bracket matching, ignoring quoted strings and comments.

    This is not a JavaScript parser. Template strings are treated as opaque;
    regex literals and malformed source can make the candidate range imprecise.
    """
    stack = []
    quote = None
    comment = None
    escaped = False
    index = start
    while index < len(text):
        char = text[index]
        pair = text[index:index + 2]
        if comment == "line":
            if char == "\n":
                comment = None
        elif comment == "block":
            if pair == "*/":
                comment = None
                index += 1
        elif quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
        elif pair == "//":
            comment = "line"
            index += 1
        elif pair == "/*":
            comment = "block"
            index += 1
        elif char in "\"'`":
            quote = char
        elif char in "[{":
            stack.append(char)
        elif char in "]}":
            if not stack or (stack[-1], char) not in {("[", "]"), ("{", "}")}:
                return index + 1
            stack.pop()
            if not stack:
                return index + 1
        index += 1
    return len(text)


def candidate_ranges(relative, text, explicit=False):
    """Yield (reason, start offset, end offset), allowing overlapping evidence."""
    suffix = Path(relative).suffix.lower()
    name = Path(relative).name.lower()
    if explicit:
        yield "explicit --include-source: source retained for manual review", 0, len(text)
    if re.search(r"mock|fixture|sample|seed", relative, re.I):
        yield "mock/fixture/sample/seed naming suggests sample data", 0, len(text)
    metadata_json = (
        name in {"package.json", "package-lock.json", "npm-shrinkwrap.json", "composer.lock"}
        or "lock" in name
        or re.match(r"(?:tsconfig|jsconfig)(?:\..*)?\.json$", name)
    )
    if suffix == ".json" and not metadata_json:
        yield "JSON document may contain hardcoded data (configuration is possible)", 0, len(text)
    if suffix in CODE_SUFFIXES:
        for match in LITERAL_PATTERN.finditer(text):
            start = match.start(1) if match.group(1) else match.start(2)
            yield "array/object literal may contain hardcoded data", start, literal_end(text, start)
        for match in re.finditer(
            r"<script\b[^>]*\btype\s*=\s*['\"](?:application/(?:ld\+)?json|text/json)['\"][^>]*>.*?</script\s*>",
            text, re.I | re.S,
        ):
            yield "inline JSON script may contain hardcoded data", match.start(), match.end()
        for match in re.finditer(r"<(table|ul|ol|select)\b[^>]*>.*?</\1\s*>", text, re.I | re.S):
            tag = match.group(1).lower()
            child = {"table": "tr", "ul": "li", "ol": "li", "select": "option"}[tag]
            if len(re.findall(r"<" + child + r"\b", match.group(), re.I)) >= 2:
                yield "repeated DOM " + tag + " items may contain hardcoded data", match.start(), match.end()
        for match in re.finditer(r"\bdata-[\w:-]+\s*=\s*(?:\"[^\"]*\"|'[^']*'|[^\s>]+)", text, re.I):
            yield "DOM data-* attribute may contain hardcoded data", match.start(), match.end()


def is_within(path, parent):
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def normalize_explicit(values):
    paths = set()
    for value in values:
        path = Path(value)
        if path.is_absolute() or ".." in path.parts or not path.parts:
            raise ValueError("--include-source must be a relative file path without '..': " + value)
        paths.add(path.as_posix())
    return paths


def read_regular_file(path):
    """Do not follow a file symlink, including replacement between walk/read."""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    descriptor = os.open(path, flags)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise OSError("not a regular file")
        with os.fdopen(descriptor, "rb") as source:
            descriptor = None
            return source.read()
    finally:
        if descriptor is not None:
            os.close(descriptor)


def inventory_demo(input_dir, output_dir, include_source=(), include_generated=False):
    input_path = Path(input_dir).expanduser()
    if input_path.is_symlink():
        raise ValueError("input root must not be a symbolic link")
    source_root = input_path.resolve(strict=True)
    if not source_root.is_dir():
        raise ValueError("input must be a directory")
    output_path = Path(output_dir).expanduser()
    if output_path.exists() or output_path.is_symlink():
        raise ValueError("output must be a new directory; refusing to overwrite: " + str(output_path))
    output_root = output_path.resolve()
    if is_within(output_root, source_root) or is_within(source_root, output_root):
        raise ValueError("input and output must not overlap (same directory, ancestor, or descendant)")
    explicit = normalize_explicit(include_source)
    result = {
        "schema_version": 1,
        "source_root": str(source_root),
        "files": [],
        "entry_candidates": [],
        "document_candidates": [],
        "mock_candidates": [],
        "exclusions": [],
        "limitations": [
            "Candidate detection is heuristic, not a completeness guarantee. Review every source role; use --include-source to add missed source snapshots.",
            "No input JavaScript or package script was executed. Entry candidates are not verified runtime routes.",
        ],
        "warnings": [],
    }
    source_files = []

    def exclude(relative, reason):
        result["exclusions"].append({"path": relative, "reason": reason})

    def walk_error(error):
        filename = Path(error.filename) if error.filename else source_root
        relative = os.path.relpath(filename, source_root)
        exclude(relative, "directory_read_error: " + str(error))
        result["warnings"].append("Could not enumerate directory: " + relative)

    for base, directories, files in os.walk(source_root, topdown=True, followlinks=False, onerror=walk_error):
        base_path = Path(base)
        accepted = []
        for dirname in sorted(directories):
            path = base_path / dirname
            relative = path.relative_to(source_root).as_posix()
            if path.is_symlink():
                exclude(relative, "symbolic_link_directory: not followed")
            elif dirname.lower() in EXCLUDED_DIRS:
                exclude(relative, "vendor/cache/internal directory excluded")
            elif dirname.lower() in GENERATED_DIRS and not include_generated:
                exclude(relative, "generated directory excluded; use --include-generated for a generated-only demo")
            else:
                accepted.append(dirname)
        directories[:] = accepted
        for filename in sorted(files):
            path = base_path / filename
            relative = path.relative_to(source_root).as_posix()
            if path.is_symlink():
                exclude(relative, "symbolic_link_file: not followed")
            elif path.suffix.lower() not in TEXT_SUFFIXES and relative not in explicit:
                reason = "static_asset" if path.suffix.lower() in STATIC_ASSET_SUFFIXES else "unsupported_file_type"
                exclude(relative, reason)
            else:
                source_files.append((relative, path))

    # Create exclusively only after validating paths and walking the source.
    output_root.mkdir(parents=True, exist_ok=False)
    processed_explicit = set()
    for relative, path in sorted(source_files):
        try:
            data = read_regular_file(path)
        except OSError as error:
            exclude(relative, "file_read_error: " + str(error))
            result["warnings"].append("Could not read file: " + relative)
            continue
        text, encoding = decode_text(data)
        if "fallback" in encoding or "replacement" in encoding:
            result["warnings"].append(relative + ": analyzed using " + encoding + "; raw bytes are unchanged")
        file_id = "F-" + str(len(result["files"]) + 1).zfill(4)
        digest = sha256(data)
        roles = []
        suffix = path.suffix.lower()
        text_lines = text.splitlines(keepends=True)
        line_starts = []
        offset = 0
        for text_line in text_lines:
            line_starts.append(offset)
            offset += len(text_line)

        def lines(start, end):
            if not text_lines:
                return 0, 0
            return bisect.bisect_right(line_starts, start), bisect.bisect_right(line_starts, max(start, end - 1))

        if suffix in DOCUMENT_SUFFIXES:
            roles.append("document_candidate")
            result["document_candidates"].append({
                "id": "DC-" + str(len(result["document_candidates"]) + 1).zfill(4),
                "file_id": file_id, "path": relative,
                "reason": "HTML/Markdown/text may include interaction requirements; classification requires reading",
            })
        if suffix in {".html", ".htm"}:
            roles.append("entry_candidate")
            result["entry_candidates"].append({
                "id": "EC-" + str(len(result["entry_candidates"]) + 1).zfill(4),
                "file_id": file_id, "path": relative, "kind": "html",
                "reason": "HTML file is a possible entry or documentation file; verify by source and runtime",
            })
        if path.name.lower() == "package.json":
            roles.append("package_metadata")
            entry = {
                "id": "EC-" + str(len(result["entry_candidates"]) + 1).zfill(4),
                "file_id": file_id, "path": relative, "kind": "package_metadata",
                "reason": "Package scripts/framework metadata may identify an SPA launch path; scripts are unexecuted",
            }
            try:
                metadata = json.loads(text)
                if isinstance(metadata, dict):
                    dependencies = {}
                    for key in ("dependencies", "devDependencies"):
                        if isinstance(metadata.get(key), dict):
                            dependencies.update(metadata[key])
                    entry["framework_hints"] = sorted(set(dependencies) & {"react", "react-dom", "vue", "@angular/core", "svelte", "next", "nuxt"})
                    entry["script_names"] = sorted(metadata.get("scripts", {})) if isinstance(metadata.get("scripts"), dict) else []
                else:
                    result["warnings"].append(relative + ": package metadata is not a JSON object")
            except (ValueError, TypeError) as error:
                result["warnings"].append(relative + ": invalid package JSON: " + str(error))
            result["entry_candidates"].append(entry)
        if relative in explicit:
            processed_explicit.add(relative)
        candidates = list(candidate_ranges(relative, text, relative in explicit))
        if candidates:
            roles.append("mock_candidate_source")
            snapshot_relative = (Path("mock-data") / "raw" / relative).as_posix()
            snapshot_path = output_root / snapshot_relative
            snapshot_path.parent.mkdir(parents=True, exist_ok=True)
            with snapshot_path.open("xb") as snapshot:
                snapshot.write(data)
            seen = set()
            for reason, start, end in candidates:
                line_start, line_end = lines(start, end)
                key = (reason, line_start, line_end)
                if key in seen:
                    continue
                seen.add(key)
                result["mock_candidates"].append({
                    "id": "MC-" + str(len(result["mock_candidates"]) + 1).zfill(4),
                    "source_file": file_id, "path": relative, "reason": reason,
                    "line_start": line_start, "line_end": line_end,
                    "snapshot": snapshot_relative, "sha256": digest,
                })
        if not roles:
            roles.append("source")
        result["files"].append({
            "id": file_id, "path": relative, "sha256": digest,
            "size": len(data), "roles": roles,
            "line_count": len(text_lines), "encoding": encoding,
        })
    for relative in sorted(explicit - processed_explicit):
        result["warnings"].append("Explicit source was not included (missing, unreadable, symlink, or excluded directory): " + relative)
    if not result["files"]:
        result["warnings"].append("No eligible readable source files found; inspect exclusions and consider --include-generated.")
    if include_generated:
        result["limitations"].append("Generated dist/build directories were included by explicit request; generated bundles may be large and candidate ranges imprecise.")
    result["exclusions"].sort(key=lambda item: (item["path"], item["reason"]))
    with (output_root / "inventory.json").open("x", encoding="utf-8") as inventory:
        json.dump(result, inventory, ensure_ascii=False, indent=2)
        inventory.write("\n")
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_dir", type=Path)
    parser.add_argument("--output", required=True, type=Path, help="new directory disjoint from the input directory")
    parser.add_argument("--include-source", action="append", default=[], metavar="RELATIVE_PATH", help="add a source snapshot even when heuristics miss it; repeatable; does not bypass excluded directories or symlinks")
    parser.add_argument("--include-generated", action="store_true", help="include dist/build directories (vendor/cache directories remain excluded)")
    args = parser.parse_args(argv)
    try:
        result = inventory_demo(args.input_dir, args.output, args.include_source, args.include_generated)
    except (OSError, ValueError) as error:
        parser.exit(2, "error: " + str(error) + "\n")
    print(json.dumps({"inventory": str(args.output.resolve() / "inventory.json"), "files": len(result["files"]), "mock_candidates": len(result["mock_candidates"]), "warnings": len(result["warnings"])}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
