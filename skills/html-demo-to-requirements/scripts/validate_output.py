#!/usr/bin/env python3
"""Validate an HTML Demo requirements package using only its inventory and snapshots."""

import argparse
import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path, PurePosixPath, PureWindowsPath


AUDIT_FIELDS = {
    "file_reviews": {"file_id": str, "status": str, "reason": str},
    "entry_reviews": {"candidate_id": str, "decision": str, "page_ids": list, "reason": str},
    "documents": {"file_id": str, "status": str, "note_ids": list, "reason": str},
    "notes": {"id": str, "evidence": list, "decision": str, "targets": list},
    "pages": {"id": str, "entry_file": str, "locator": str, "kind": str, "status": str, "evidence": list},
    "modules": {"id": str, "name": str, "scope": str, "evidence": list, "reason": str},
    "evidence": {"id": str, "file_id": str, "line_start": int, "line_end": int, "kind": str, "detail": str},
    "requirements": {"id": str, "title": str, "module_id": str, "page_ids": list, "evidence": list, "acceptance": list, "mock_ids": list},
    "interactions": {"id": str, "page_id": str, "module_id": str, "label": str, "disposition": str, "requirement_ids": list, "evidence": list, "reason": str},
    "mocks": {"id": str, "module_id": str, "source_file": str, "snapshot": str, "sha256": str, "line_start": int, "line_end": int},
    "mock_reviews": {"candidate_id": str, "decision": str, "mock_ids": list, "reason": str},
    "questions": {"id": str, "detail": str, "evidence": list, "blocking": bool},
}
INVENTORY_FIELDS = {
    "files": {"id": str, "path": str, "sha256": str, "size": int, "roles": list},
    "entry_candidates": {"id": str, "file_id": str},
    "document_candidates": {"file_id": str},
    "mock_candidates": {"id": str, "source_file": str, "path": str, "reason": str, "line_start": int, "line_end": int, "snapshot": str, "sha256": str},
}
ENUMS = {
    ("file_reviews", "status"): {"reviewed", "not_applicable", "deferred"},
    ("documents", "status"): {"reviewed", "not_applicable", "deferred"},
    ("entry_reviews", "decision"): {"page", "document", "asset", "deferred"},
    ("notes", "decision"): {"requirement", "exclude", "context", "question"},
    ("pages", "kind"): {"html", "route", "state"},
    ("pages", "status"): {"verified", "static_only", "blocked"},
    ("modules", "scope"): {"included", "excluded", "pending"},
    ("evidence", "kind"): {"source", "document", "runtime"},
    ("interactions", "disposition"): {"requirement", "excluded", "not_applicable", "pending"},
    ("mock_reviews", "decision"): {"backed_up", "not_mock", "pending"},
}


def strings(value):
    return [v for v in value if isinstance(v, str)] if isinstance(value, list) else []


class Validator:
    def __init__(self, output_dir):
        self.root = Path(output_dir).resolve()
        self.errors = []
        self.gaps = []
        self.coverage = {}
        self.limitations = [
            "机器检查不能证明不存在未知入口、动态路由、未提取的交互或补充条款。",
            "机器检查不能证明复用范围理解、需求措辞或验收条件正确；review.md 的存在不等于语义审查已通过。",
            "仅校验执行记录的结构，无法证明 subagents_used 或运行验证声明真实。",
            "不读取或执行 source_root 中的文件；仅以清单和输出内快照验证备份，不能独立证明清单反映原始输入。",
        ]
        self.inventory = {}
        self.audit = {}
        self.inv = {}
        self.rows = {}
        self.indexes = {}
        self.file_lines = {}
        self.file_sizes = {}
        self.file_content = {}
        self.checked_paths = {}

    def error(self, message):
        self.errors.append(message)

    def gap(self, message):
        self.gaps.append(message)

    def load(self, name):
        path = self.safe_path(name, name)
        if path is None:
            return {}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, ValueError) as exc:
            self.error(f"{name}: 无法读取有效 UTF-8 JSON ({type(exc).__name__})")
            return {}
        if not isinstance(data, dict):
            self.error(f"{name}: 顶层必须为对象")
            return {}
        return data

    def relative_path(self, value, label):
        if not isinstance(value, str) or not value or "\x00" in value:
            self.error(f"{label}: 必须为非空安全相对路径")
            return False
        if "\\" in value or PurePosixPath(value).is_absolute() or PureWindowsPath(value).is_absolute() or ".." in PurePosixPath(value).parts:
            self.error(f"{label}: 路径逃逸或非相对路径 {value!r}")
            return False
        return True

    def safe_path(self, value, label, nonempty=False):
        if not self.relative_path(value, label):
            return None
        try:
            path = (self.root / value).resolve()
            path.relative_to(self.root)
            if not path.is_file():
                self.error(f"{label}: 文件不存在 {value}")
                return None
            if nonempty and path.stat().st_size == 0:
                self.error(f"{label}: 文件为空，不能作为实际证据 {value}")
                return None
            return path
        except (OSError, ValueError, RuntimeError):
            self.error(f"{label}: 无法安全访问输出目录内文件 {value!r}")
            return None

    def validate_rows(self, data, key, fields, prefix):
        value = data.get(key)
        if not isinstance(value, list):
            self.error(f"{prefix}.{key}: 必须为数组")
            return []
        rows = []
        for i, row in enumerate(value):
            label = f"{prefix}.{key}[{i}]"
            if not isinstance(row, dict):
                self.error(f"{label}: 必须为对象")
                continue
            rows.append(row)
            for field, expected in fields.items():
                item = row.get(field)
                valid = type(item) is expected
                if not valid:
                    self.error(f"{label}.{field}: 必须为 {expected.__name__}")
                    continue
                if expected is str and not item.strip():
                    self.error(f"{label}.{field}: 不能为空")
                if expected is list:
                    if any(not isinstance(v, str) or not v.strip() for v in item):
                        self.error(f"{label}.{field}: 只能包含非空字符串")
                    if len(strings(item)) != len(set(strings(item))):
                        self.error(f"{label}.{field}: 存在重复值")
            for (array, field), allowed in ENUMS.items():
                if prefix == "audit" and array == key:
                    if not isinstance(row.get(field), str) or row[field] not in allowed:
                        self.error(f"{label}.{field}: 非法状态，允许 {', '.join(sorted(allowed))}")
        return rows

    def index(self, rows, key, label):
        result = {}
        for row in rows:
            value = row.get(key)
            if not isinstance(value, str) or not value:
                continue
            if value in result:
                self.error(f"{label}: 重复 ID {value}")
            else:
                result[value] = row
        return result

    def ref(self, value, index, label):
        if not isinstance(value, str) or value not in index:
            self.error(f"{label}: 未知引用 {value!r}")
            return None
        return index[value]

    def refs(self, values, index, label, required=False):
        values = strings(values)
        if required and not values:
            self.error(f"{label}: 引用数组不得为空")
        return [self.ref(value, index, label) for value in values]

    def line_range(self, row, file_id, label, allow_empty=False):
        start, end = row.get("line_start"), row.get("line_end")
        if allow_empty and type(start) is int and type(end) is int and start == end == 0 and self.file_sizes.get(file_id) == 0:
            return
        if type(start) is not int or type(end) is not int or start < 1 or end < start:
            self.error(f"{label}: 非法行范围")
            return
        upper = self.file_lines.get(file_id) if isinstance(file_id, str) else None
        if upper is not None and end > upper:
            self.error(f"{label}: 行范围超出快照/清单行数 {upper}")

    def snapshot(self, row, file_row, label):
        path = self.safe_path(row.get("snapshot"), f"{label}.snapshot")
        if path is None:
            return
        try:
            content = self.checked_paths.get(path)
            if content is None:
                content = path.read_bytes()
                self.checked_paths[path] = content
        except OSError:
            self.error(f"{label}: 快照不可读")
            return
        digest = hashlib.sha256(content).hexdigest()
        provided = row.get("sha256")
        if not isinstance(provided, str) or provided.lower() != digest:
            self.error(f"{label}: 快照 hash 不匹配")
        if file_row:
            source_hash = file_row.get("sha256")
            if not isinstance(source_hash, str) or source_hash.lower() != digest:
                self.error(f"{label}: 快照 hash 与 inventory source hash 不一致")
            if file_row.get("size") != len(content):
                self.error(f"{label}: 快照字节数与 inventory 不一致")
            file_id = file_row.get("id")
            if isinstance(file_id, str):
                if file_id not in self.file_lines:
                    encoding = file_row.get("encoding", "utf-8")
                    codec = encoding.split(" ", 1)[0] if isinstance(encoding, str) else "utf-8"
                    try:
                        self.file_lines[file_id] = len(content.decode(codec).splitlines())
                    except (LookupError, UnicodeError):
                        self.limitations.append(f"{label}: 无可靠解码信息，不能由快照验证行数上界。")
                self.file_sizes[file_id] = len(content)
                self.file_content[file_id] = content
        has_start, has_end = "start_byte" in row, "end_byte" in row
        if has_start != has_end:
            self.error(f"{label}: start_byte/end_byte 必须同时出现")
        elif has_start:
            start, end = row["start_byte"], row["end_byte"]
            if type(start) is not int or type(end) is not int or not 0 <= start < end <= len(content):
                self.error(f"{label}: 非法字节 span")
        if "snippet_path" in row or "snippet_sha256" in row:
            snippet_path = self.safe_path(row.get("snippet_path"), label + ".snippet_path")
            start, end = row.get("start_byte"), row.get("end_byte")
            valid_span = type(start) is int and type(end) is int and 0 <= start < end <= len(content)
            if not valid_span:
                self.error(f"{label}: 原始片段必须提供有效 start_byte/end_byte")
            if snippet_path is not None:
                snippet = snippet_path.read_bytes()
                if row.get("snippet_sha256") != hashlib.sha256(snippet).hexdigest():
                    self.error(f"{label}: 原始片段 hash 不匹配")
                if valid_span and snippet != content[start:end]:
                    self.error(f"{label}: 原始片段与源快照字节切片不一致")

    def covered(self, expected, actual, label):
        missing = set(expected) - set(actual)
        unknown = set(actual) - set(expected)
        for item in sorted(missing):
            self.error(f"{label}: 缺失候选判读 {item}")
        for item in sorted(unknown):
            self.error(f"{label}: 未知候选引用 {item}")

    def schema(self):
        for name, data in (("inventory", self.inventory), ("audit", self.audit)):
            if type(data.get("schema_version")) is not int or data.get("schema_version") != 1:
                self.error(f"{name}.schema_version: 必须为整数 1")
        source_root = self.inventory.get("source_root")
        if not isinstance(source_root, str) or not (PurePosixPath(source_root).is_absolute() or PureWindowsPath(source_root).is_absolute()):
            self.error("inventory.source_root: 必须为绝对路径字符串")
        for key, fields in INVENTORY_FIELDS.items():
            self.inv[key] = self.validate_rows(self.inventory, key, fields, "inventory")
        for key in ("warnings", "exclusions"):
            if not isinstance(self.inventory.get(key), list):
                self.error(f"inventory.{key}: 必须为数组")
        for key, fields in AUDIT_FIELDS.items():
            self.rows[key] = self.validate_rows(self.audit, key, fields, "audit")
        for key, rows in self.rows.items():
            id_key = "file_id" if key in {"file_reviews", "documents"} else "candidate_id" if key in {"entry_reviews", "mock_reviews"} else "id"
            self.indexes[key] = self.index(rows, id_key, f"audit.{key}")
        execution = self.audit.get("execution")
        if not isinstance(execution, dict):
            self.error("audit.execution: 必須为对象")
        else:
            count = execution.get("subagents_used")
            if type(count) is not int or count < 0:
                self.error("audit.execution.subagents_used: 必须为非负整数")
            if not isinstance(execution.get("parallel_reason"), str) or not execution["parallel_reason"].strip():
                self.error("audit.execution.parallel_reason: 必须为非空字符串")
        terms = self.audit.get("forbidden_terms")
        if not isinstance(terms, list) or any(not isinstance(v, str) or not v.strip() for v in terms):
            self.error("audit.forbidden_terms: 必须为非空字符串组成的数组，可以为空数组")

    def inventories(self):
        self.files = self.index(self.inv["files"], "id", "inventory.files")
        paths = self.index(self.inv["files"], "path", "inventory.files.path")
        del paths
        self.entries = self.index(self.inv["entry_candidates"], "id", "inventory.entry_candidates")
        self.docs = self.index(self.inv["document_candidates"], "file_id", "inventory.document_candidates")
        self.candidates = self.index(self.inv["mock_candidates"], "id", "inventory.mock_candidates")
        for file_id, row in self.files.items():
            self.relative_path(row.get("path"), f"inventory.files[{file_id}].path")
            if not isinstance(row.get("sha256"), str) or not re.fullmatch(r"[0-9a-fA-F]{64}", row["sha256"]):
                self.error(f"inventory.files[{file_id}]: 非法 SHA-256")
            size = row.get("size")
            if type(size) is not int or size < 0:
                self.error(f"inventory.files[{file_id}]: size 必须为非负整数")
            else:
                self.file_sizes[file_id] = size
            if "line_count" in row:
                count = row["line_count"]
                if type(count) is not int or count < 0:
                    self.error(f"inventory.files[{file_id}]: line_count 必须为非负整数")
                else:
                    self.file_lines[file_id] = count
        for row in self.inv["entry_candidates"] + self.inv["document_candidates"]:
            self.ref(row.get("file_id"), self.files, "inventory candidate.file_id")
        for row in self.inv["mock_candidates"]:
            file_row = self.ref(row.get("source_file"), self.files, "inventory.mock_candidates.source_file")
            if file_row and row.get("path") != file_row.get("path"):
                self.error(f"mock candidate {row.get('id')}: path 与 source_file 不一致")
            self.snapshot(row, file_row, f"mock candidate {row.get('id')}")
            self.line_range(row, row.get("source_file"), f"mock candidate {row.get('id')}", allow_empty=True)
        self.covered(self.files, self.indexes["file_reviews"], "file_reviews")
        self.covered(self.entries, self.indexes["entry_reviews"], "entry_reviews")
        self.covered(self.candidates, self.indexes["mock_reviews"], "mock_reviews")
        for file_id in self.docs:
            if file_id not in self.indexes["documents"]:
                self.error(f"documents: 缺失候选判读 {file_id}")
        for row in self.rows["file_reviews"] + self.rows["documents"]:
            self.ref(row.get("file_id"), self.files, "file/document review.file_id")

    def relations(self):
        idx = self.indexes
        for key in ("pages", "modules", "notes", "requirements", "interactions", "questions"):
            for row in self.rows[key]:
                self.refs(row.get("evidence"), idx["evidence"], f"{key} {row.get('id')}.evidence", required=True)
        for row in self.rows["mocks"]:
            label = f"mock {row.get('id')}"
            self.ref(row.get("module_id"), idx["modules"], label + ".module_id")
            file_row = self.ref(row.get("source_file"), self.files, label + ".source_file")
            self.snapshot(row, file_row, label)
            self.line_range(row, row.get("source_file"), label)
            if "normalized_path" in row:
                self.safe_path(row["normalized_path"], label + ".normalized_path")
        for row in self.rows["evidence"]:
            label = f"evidence {row.get('id')}"
            self.ref(row.get("file_id"), self.files, label + ".file_id")
            self.line_range(row, row.get("file_id"), label)
            if row.get("kind") == "runtime":
                self.safe_path(row.get("artifact"), label + ".artifact", nonempty=True)
        for row in self.rows["pages"]:
            self.ref(row.get("entry_file"), self.files, f"page {row.get('id')}.entry_file")
            if row.get("status") == "verified" and not any(idx["evidence"].get(ev, {}).get("kind") == "runtime" for ev in strings(row.get("evidence"))):
                self.error(f"page {row.get('id')}: verified 必须关联实际 runtime 证据")
        for row in self.rows["entry_reviews"]:
            self.refs(row.get("page_ids"), idx["pages"], f"entry {row.get('candidate_id')}.page_ids", row.get("decision") == "page")
        for row in self.rows["requirements"]:
            label = f"requirement {row.get('id')}"
            module = self.ref(row.get("module_id"), idx["modules"], label + ".module_id")
            if module and module.get("scope") != "included":
                self.error(label + ": excluded/pending 模块污染需求")
            self.refs(row.get("page_ids"), idx["pages"], label + ".page_ids", required=True)
            if not strings(row.get("acceptance")):
                self.error(label + ".acceptance: 不能为空")
            for mock in self.refs(row.get("mock_ids"), idx["mocks"], label + ".mock_ids"):
                if mock:
                    owner = idx["modules"].get(mock.get("module_id")) if isinstance(mock.get("module_id"), str) else None
                    if owner and owner.get("scope") != "included":
                        self.error(label + ": 引用了 excluded/pending mock")
        for row in self.rows["interactions"]:
            label = f"interaction {row.get('id')}"
            self.ref(row.get("page_id"), idx["pages"], label + ".page_id")
            module = self.ref(row.get("module_id"), idx["modules"], label + ".module_id")
            disposition = row.get("disposition")
            reqs = self.refs(row.get("requirement_ids"), idx["requirements"], label + ".requirement_ids", disposition == "requirement")
            if disposition == "excluded" and module and module.get("scope") != "excluded":
                self.error(label + ": excluded 只能归 excluded 模块")
            if disposition == "requirement" and module and module.get("scope") != "included":
                self.error(label + ": requirement 只能归 included 模块")
            for req in reqs:
                if req and (req.get("module_id") != row.get("module_id") or row.get("page_id") not in strings(req.get("page_ids"))):
                    self.error(label + ": 需求必须关联相同模块及页面")
        note_owners = {}
        for row in self.rows["documents"]:
            for note_id in strings(row.get("note_ids")):
                self.ref(note_id, idx["notes"], f"document {row.get('file_id')}.note_ids")
                note_owners.setdefault(note_id, []).append(row.get("file_id"))
        all_targets = dict(idx["requirements"])
        all_targets.update(idx["modules"])
        all_targets.update(idx["questions"])
        for row in self.rows["notes"]:
            label = f"note {row.get('id')}"
            note_id = row.get("id")
            owners = note_owners.get(note_id, []) if isinstance(note_id, str) else []
            if not owners:
                self.error(label + ": 未映射到 documents.note_ids")
            for owner in owners:
                if not any(idx["evidence"].get(ev, {}).get("file_id") == owner and idx["evidence"].get(ev, {}).get("kind") == "document" for ev in strings(row.get("evidence"))):
                    self.error(label + ": 缺少所属补充文档的 document 证据")
            self.refs(row.get("targets"), all_targets, label + ".targets", row.get("decision") != "context")
            target_ids = strings(row.get("targets"))
            decision = row.get("decision")
            required_index = idx["requirements"] if decision == "requirement" else idx["questions"] if decision == "question" else None
            if required_index is not None and not any(t in required_index for t in target_ids):
                self.error(label + ": decision 与 targets 类型不一致")
            if decision == "exclude" and not any(idx["modules"].get(t, {}).get("scope") == "excluded" for t in target_ids):
                self.error(label + ": exclude 必须指向 excluded 模块")
        backed_up = set()
        for row in self.rows["mock_reviews"]:
            label = f"mock review {row.get('candidate_id')}"
            candidate = self.ref(row.get("candidate_id"), self.candidates, label)
            mocks = self.refs(row.get("mock_ids"), idx["mocks"], label + ".mock_ids", row.get("decision") == "backed_up")
            if row.get("decision") == "backed_up":
                for mock in mocks:
                    if mock and candidate:
                        if mock.get("source_file") != candidate.get("source_file"):
                            self.error(label + ": backed_up MOCK 必须与候选同 source_file")
                        else:
                            backed_up.add(mock.get("id"))
        for mock_id in idx["mocks"]:
            if mock_id not in backed_up:
                self.error(f"mock {mock_id}: 没有 backed_up 候选映射")

    def markdown(self):
        texts = {}
        for name in ("requirements.md", "mock-data.md", "review.md"):
            path = self.safe_path(name, name, nonempty=True)
            if path:
                try:
                    texts[name] = path.read_text(encoding="utf-8")
                except (OSError, UnicodeError):
                    self.error(f"{name}: 无法读取 UTF-8 文本")
        expected_req = set(self.indexes["requirements"])
        included_mocks = {key for key, row in self.indexes["mocks"].items() if isinstance(row.get("module_id"), str) and self.indexes["modules"].get(row["module_id"], {}).get("scope") == "included"}
        for name, prefix, expected in (("requirements.md", "REQ", expected_req), ("mock-data.md", "MOCK", included_mocks)):
            content = texts.get(name, "")
            headings = []
            fence = None
            for line in content.splitlines():
                stripped = line.lstrip()
                fence_match = re.match(r"(`{3,}|~{3,})", stripped)
                if fence_match:
                    marker = fence_match.group(1)[0]
                    if fence is None:
                        fence = marker
                    elif fence == marker:
                        fence = None
                    continue
                if fence is None:
                    match = re.match(rf"^### ({prefix}-[A-Za-z0-9_-]+)\s+\S", line)
                    if match:
                        headings.append(match.group(1))
            if set(headings) != expected:
                self.error(f"{name}: {prefix} Markdown 标题集合不匹配，缺失 {sorted(expected - set(headings))}，多余 {sorted(set(headings) - expected)}")
            for key, count in Counter(headings).items():
                if count > 1:
                    self.error(f"{name}: 重复 Markdown 标题 {key}")
        for name in ("requirements.md", "mock-data.md"):
            content = texts.get(name, "")
            for module_id, row in self.indexes["modules"].items():
                if row.get("scope") in {"excluded", "pending"} and re.search(rf"(?<![A-Za-z0-9_-]){re.escape(module_id)}(?![A-Za-z0-9_-])", content):
                    self.error(f"{name}: excluded/pending 模块 ID 污染 {module_id}")
            for mock_id, row in self.indexes["mocks"].items():
                if mock_id not in included_mocks and re.search(rf"(?<![A-Za-z0-9_-]){re.escape(mock_id)}(?![A-Za-z0-9_-])", content):
                    self.error(f"{name}: excluded/pending mock 引用污染 {mock_id}")
            for term in strings(self.audit.get("forbidden_terms")):
                if term in content:
                    self.error(f"{name}: 发现排除模块禁词 {term!r}")
            for prefix, known in (("REQ", expected_req), ("MOCK", included_mocks), ("EV", set(self.indexes["evidence"])), ("PAGE", set(self.indexes["pages"])), ("MOD", set(self.indexes["modules"]))):
                for identifier in set(re.findall(rf"(?<![A-Za-z0-9_-]){prefix}-[A-Za-z0-9_-]+", content)):
                    if identifier not in known:
                        self.error(f"{name}: 未知或不允许的正文引用 {identifier}")

    def tally(self, name, expected, actual, field, completed):
        counts = Counter(row.get(field) for key, row in actual.items() if key in expected and isinstance(row.get(field), str))
        done = sum(counts.get(state, 0) for state in completed)
        self.coverage[name] = {"total": len(expected), "reviewed": done, "gaps": len(expected) - done, "by_status": dict(sorted(counts.items()))}

    def coverage_and_gaps(self):
        idx = self.indexes
        self.tally("files", self.files, idx["file_reviews"], "status", {"reviewed", "not_applicable"})
        self.tally("entries", self.entries, idx["entry_reviews"], "decision", {"page", "document", "asset"})
        self.tally("documents", self.docs, idx["documents"], "status", {"reviewed", "not_applicable"})
        self.tally("notes", idx["notes"], idx["notes"], "decision", {"requirement", "exclude", "context"})
        self.tally("interactions", idx["interactions"], idx["interactions"], "disposition", {"requirement", "excluded", "not_applicable"})
        self.tally("mock_candidates", self.candidates, idx["mock_reviews"], "decision", {"backed_up", "not_mock"})
        self.tally("pages", idx["pages"], idx["pages"], "status", {"verified"})
        for key, field, states in (("file_reviews", "status", {"deferred"}), ("entry_reviews", "decision", {"deferred"}), ("documents", "status", {"deferred"}), ("pages", "status", {"static_only", "blocked"}), ("modules", "scope", {"pending"}), ("interactions", "disposition", {"pending"}), ("mock_reviews", "decision", {"pending"})):
            for i, row in enumerate(self.rows[key]):
                if isinstance(row.get(field), str) and row[field] in states:
                    self.gap(f"{key}[{i}]: {row[field]} 尚未完成")
        for row in self.rows["questions"]:
            self.gap(f"question {row.get('id')}: {row.get('detail')} (blocking={row.get('blocking')})")
        warnings = self.inventory.get("warnings", [])
        if isinstance(warnings, list):
            for warning in warnings:
                self.gap("inventory warning: " + json.dumps(warning, ensure_ascii=False))
        exclusions = self.inventory.get("exclusions", [])
        if isinstance(exclusions, list):
            for exclusion in exclusions:
                reason = exclusion.get("reason", "") if isinstance(exclusion, dict) else exclusion
                text = str(reason).lower()
                clear_nonbusiness = any(word in text for word in ("vendor", "dependency", "static_asset", "cache", "依赖", "静态资源", "缓存"))
                uncertain = any(word in text for word in ("unreadable", "symlink", "symbolic_link", "read_error", "permission", "failed", "limit", "size", "decode", "unavailable", "符号链接", "无法", "失败", "过大"))
                if uncertain or not clear_nonbusiness:
                    self.gap("inventory exclusion 可能影响覆盖: " + json.dumps(exclusion, ensure_ascii=False))
        if any(isinstance(row.get("file_id"), str) and row["file_id"] not in self.file_lines for row in self.rows["evidence"]):
            self.limitations.append("部分证据文件没有快照或 line_count，仅检查行号正整数及顺序，未验证源行数上界。")
        if "limitations" in self.inventory:
            limitations = self.inventory["limitations"]
            if not isinstance(limitations, list) or any(not isinstance(item, str) for item in limitations):
                self.error("inventory.limitations: 必须为字符串数组")
            else:
                self.limitations.extend(limitations)

    def run(self):
        self.inventory = self.load("inventory.json")
        self.audit = self.load("audit.json")
        self.schema()
        self.inventories()
        self.relations()
        self.markdown()
        self.coverage_and_gaps()
        return self.report()

    def report(self):
        errors = list(dict.fromkeys(self.errors))
        gaps = list(dict.fromkeys(self.gaps))
        return {"schema_version": 1, "status": "failed" if errors else "incomplete" if gaps else "passed", "errors": errors, "gaps": gaps, "coverage": self.coverage, "limitations": self.limitations}


def validate_output(output_dir):
    validator = Validator(output_dir)
    try:
        return validator.run()
    except (OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError, RuntimeError) as exc:
        # Malformed or concurrently removed input should produce a usable failure report.
        validator.error(f"无法完成校验 ({type(exc).__name__}): {exc}")
        return validator.report()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args(argv)
    report = validate_output(args.output_dir)
    target = args.output_dir / "verification.json"
    try:
        if target.is_symlink():
            raise ValueError("verification.json 不允许为符号链接")
        target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except (OSError, ValueError) as exc:
        report["errors"].append(f"无法写入 verification.json ({type(exc).__name__})")
        report["status"] = "failed"
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return {"passed": 0, "failed": 1, "incomplete": 2}[report["status"]]


if __name__ == "__main__":
    sys.exit(main())
