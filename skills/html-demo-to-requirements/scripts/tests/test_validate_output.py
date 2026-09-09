"""Contract tests for structural, scope, provenance and coverage failures."""

import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "validate_output.py"
SPEC = importlib.util.spec_from_file_location("validate_output", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class OutputValidationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "output"
        self.root.mkdir()
        self.source = b"<!doctype html>\n<button>Search</button>\n<script>const rows = [{id: 1}];</script>\n<p>Click Search to filter.</p>\n"
        self.digest = hashlib.sha256(self.source).hexdigest()
        self.snapshot = self.root / "mock-data/raw/index.html"
        self.snapshot.parent.mkdir(parents=True)
        self.snapshot.write_bytes(self.source)
        (self.root / "evidence").mkdir()
        (self.root / "evidence/visit.log").write_text("Opened index.html and clicked Search; one record remained.\n", encoding="utf-8")
        self.inventory = {
            "schema_version": 1,
            "source_root": "/nonexistent/source/must-never-be-read",
            "files": [{"id": "F-0001", "path": "index.html", "sha256": self.digest, "size": len(self.source), "roles": ["html", "document", "mock_source"], "line_count": 4, "encoding": "utf-8"}],
            "entry_candidates": [{"id": "EC-0001", "file_id": "F-0001"}],
            "document_candidates": [{"file_id": "F-0001"}],
            "mock_candidates": [{"id": "MC-0001", "source_file": "F-0001", "path": "index.html", "reason": "literal array", "line_start": 3, "line_end": 3, "snapshot": "mock-data/raw/index.html", "sha256": self.digest}],
            "warnings": [], "exclusions": [], "limitations": ["Candidates are heuristic."],
        }
        self.audit = {
            "schema_version": 1,
            "execution": {"subagents_used": 0, "parallel_reason": "Small fixture analyzed sequentially."},
            "forbidden_terms": [],
            "file_reviews": [{"file_id": "F-0001", "status": "reviewed", "reason": "Read the page, script and embedded instructions."}],
            "entry_reviews": [{"candidate_id": "EC-0001", "decision": "page", "page_ids": ["PAGE-001"], "reason": "Independent HTML entry."}],
            "documents": [{"file_id": "F-0001", "status": "reviewed", "note_ids": ["NOTE-001"], "reason": "Contains one interaction instruction."}],
            "notes": [{"id": "NOTE-001", "evidence": ["EV-003"], "decision": "requirement", "targets": ["REQ-001"]}],
            "pages": [{"id": "PAGE-001", "entry_file": "F-0001", "locator": "index.html", "kind": "html", "status": "verified", "evidence": ["EV-001", "EV-002"]}],
            "modules": [{"id": "MOD-001", "name": "Search results", "scope": "included", "evidence": ["EV-001"], "reason": "Own module with no reuse statement."}],
            "evidence": [
                {"id": "EV-001", "file_id": "F-0001", "line_start": 1, "line_end": 4, "kind": "source", "detail": "Page and local sample data."},
                {"id": "EV-002", "file_id": "F-0001", "line_start": 2, "line_end": 2, "kind": "runtime", "detail": "Search click observed.", "artifact": "evidence/visit.log"},
                {"id": "EV-003", "file_id": "F-0001", "line_start": 4, "line_end": 4, "kind": "document", "detail": "Explicit instruction to filter after Search click."},
            ],
            "requirements": [{"id": "REQ-001", "title": "Filter results", "module_id": "MOD-001", "page_ids": ["PAGE-001"], "evidence": ["EV-001", "EV-003"], "acceptance": ["Click Search and verify that matching results remain."], "mock_ids": ["MOCK-001"]}],
            "interactions": [{"id": "INT-001", "page_id": "PAGE-001", "module_id": "MOD-001", "label": "Search click", "disposition": "requirement", "requirement_ids": ["REQ-001"], "evidence": ["EV-001", "EV-003"], "reason": "Covered by the filter requirement."}],
            "mocks": [{"id": "MOCK-001", "module_id": "MOD-001", "source_file": "F-0001", "snapshot": "mock-data/raw/index.html", "sha256": self.digest, "line_start": 3, "line_end": 3, "start_byte": 54, "end_byte": 60}],
            "mock_reviews": [{"candidate_id": "MC-0001", "decision": "backed_up", "mock_ids": ["MOCK-001"], "reason": "Original source bytes retained."}],
            "questions": [],
        }
        self.requirements = "# Requirements\n\n### REQ-001 Filter results\n\nPAGE-001 MOD-001 EV-001 EV-003 MOCK-001\n"
        self.mock_doc = "# Mock samples\n\n### MOCK-001 Search sample\n\nDemo sample. [Snapshot](mock-data/raw/index.html).\n"

    def tearDown(self):
        self.temp.cleanup()

    def save(self):
        for name, data in (("inventory.json", self.inventory), ("audit.json", self.audit)):
            (self.root / name).write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        (self.root / "requirements.md").write_text(self.requirements, encoding="utf-8")
        (self.root / "mock-data.md").write_text(self.mock_doc, encoding="utf-8")
        (self.root / "review.md").write_text("Compared inputs with requirements; one small fixture. No unresolved issues.\n", encoding="utf-8")

    def check(self, status="failed", error=None):
        self.save()
        report = MODULE.validate_output(self.root)
        self.assertEqual(report["status"], status, report)
        if error:
            self.assertTrue(any(error in item for item in report["errors"]), report)
        return report

    def test_complete_passes_without_accessing_source_root(self):
        report = self.check("passed")
        self.assertEqual(report["errors"], [])
        self.assertEqual(report["coverage"]["files"], {"total": 1, "reviewed": 1, "gaps": 0, "by_status": {"reviewed": 1}})
        self.assertIn("Candidates are heuristic.", report["limitations"])

    def test_static_only_is_incomplete(self):
        self.audit["pages"][0]["status"] = "static_only"
        report = self.check("incomplete")
        self.assertEqual(report["coverage"]["pages"]["reviewed"], 0)
        self.assertEqual(report["coverage"]["pages"]["gaps"], 1)

    def test_missing_candidate_review_is_error(self):
        self.audit["mock_reviews"] = []
        self.check(error="缺失候选判读")

    def test_excluded_scope_cannot_own_requirements(self):
        self.audit["modules"][0]["scope"] = "excluded"
        self.check(error="excluded/pending 模块污染需求")

    def test_unique_reuse_name_is_scanned_in_both_public_files(self):
        self.audit["forbidden_terms"] = ["Legacy Account Picker"]
        self.mock_doc += "\nLegacy Account Picker field specification.\n"
        self.check(error="禁词")

    def test_excluded_mock_reference_is_rejected(self):
        self.audit["modules"].append({"id": "MOD-002", "name": "Existing picker", "scope": "excluded", "evidence": ["EV-003"], "reason": "Explicit whole-module reuse."})
        self.audit["mocks"][0]["module_id"] = "MOD-002"
        self.check(error="excluded/pending mock")

    def test_raw_mock_tampering_is_detected(self):
        self.snapshot.write_bytes(self.source + b"tampered\n")
        self.check(error="hash")

    def test_exact_source_snippet_is_verified(self):
        row = self.audit["mocks"][0]
        snippet = self.source[row["start_byte"]:row["end_byte"]]
        (self.root / "snippet.txt").write_bytes(snippet)
        row.update(snippet_path="snippet.txt", snippet_sha256=hashlib.sha256(snippet).hexdigest())
        self.check("passed")

    def test_rehashed_tampered_snippet_cannot_replace_original_bytes(self):
        row = self.audit["mocks"][0]
        snippet = b"changed"
        (self.root / "snippet.txt").write_bytes(snippet)
        row.update(snippet_path="snippet.txt", snippet_sha256=hashlib.sha256(snippet).hexdigest())
        self.check(error="字节切片不一致")

    def test_snapshot_path_escape_is_rejected(self):
        self.audit["mocks"][0]["snapshot"] = "../outside.html"
        self.check(error="路径逃逸")

    def test_snapshot_symlink_escape_is_rejected(self):
        outside = Path(self.temp.name) / "outside.html"
        outside.write_bytes(self.source)
        self.snapshot.unlink()
        self.snapshot.symlink_to(outside)
        self.check(error="安全访问")

    def test_unknown_reference_is_rejected(self):
        self.audit["requirements"][0]["page_ids"] = ["PAGE-999"]
        self.check(error="未知引用")

    def test_duplicate_ids_are_rejected(self):
        self.audit["requirements"].append(copy.deepcopy(self.audit["requirements"][0]))
        self.check(error="重复 ID")

    def test_wrong_nested_type_returns_report_not_traceback(self):
        self.audit["modules"][0]["scope"] = ["included"]
        self.audit["execution"]["subagents_used"] = True
        self.audit["requirements"][0]["page_ids"] = "PAGE-001"
        self.check(error="必须为")

    def test_invalid_enum_is_rejected(self):
        self.audit["pages"][0]["status"] = "looks-good"
        self.check(error="非法状态")

    def test_missing_markdown_requirement_heading_is_rejected(self):
        self.requirements = "# Requirements\n\nFilter results.\n"
        self.check(error="Markdown 标题集合不匹配")

    def test_fenced_heading_does_not_count_as_requirement(self):
        self.requirements = "```markdown\n### REQ-001 Example only\n```\n"
        self.check(error="Markdown 标题集合不匹配")

    def test_duplicate_markdown_heading_is_rejected(self):
        self.requirements += "\n### REQ-001 Duplicate\n"
        self.check(error="重复 Markdown 标题")

    def test_illegal_line_ranges(self):
        for start, end in ((0, 1), (3, 2), (1, 99), (True, 2)):
            with self.subTest(start=start, end=end):
                self.audit["evidence"][0]["line_start"] = start
                self.audit["evidence"][0]["line_end"] = end
                self.check(error="行范围")

    def test_invalid_byte_span_is_rejected(self):
        self.audit["mocks"][0]["end_byte"] = len(self.source) + 1
        self.check(error="字节 span")

    def test_runtime_artifact_must_exist_and_be_nonempty(self):
        artifact = self.root / "evidence/visit.log"
        artifact.write_bytes(b"")
        self.check(error="文件为空")
        artifact.unlink()
        self.check(error="文件不存在")

    def test_verified_page_requires_runtime_evidence(self):
        self.audit["pages"][0]["evidence"] = ["EV-001"]
        self.check(error="verified 必须关联实际 runtime")

    def test_note_must_map_to_its_document_and_document_evidence(self):
        self.audit["documents"][0]["note_ids"] = []
        self.check(error="未映射到 documents")
        self.audit["documents"][0]["note_ids"] = ["NOTE-001"]
        self.audit["notes"][0]["evidence"] = ["EV-001"]
        self.check(error="所属补充文档")

    def test_mock_backed_up_mapping_requires_same_source(self):
        duplicate = copy.deepcopy(self.inventory["files"][0])
        duplicate.update(id="F-0002", path="copy.html")
        self.inventory["files"].append(duplicate)
        self.audit["file_reviews"].append({"file_id": "F-0002", "status": "reviewed", "reason": "Same demo bytes in an independent file."})
        self.inventory["mock_candidates"][0].update(source_file="F-0002", path="copy.html")
        self.check(error="同 source_file")

    def test_declared_questions_and_deferred_work_are_gaps(self):
        self.audit["file_reviews"][0]["status"] = "deferred"
        self.audit["questions"].append({"id": "QUESTION-001", "detail": "Confirm filter matching semantics.", "evidence": ["EV-003"], "blocking": False})
        report = self.check("incomplete")
        self.assertEqual(report["coverage"]["files"]["reviewed"], 0)
        self.assertGreaterEqual(len(report["gaps"]), 2)

    def test_warnings_are_gaps_but_vendor_and_assets_are_not(self):
        self.inventory["exclusions"] = [{"path": "node_modules", "reason": "vendor/cache/internal directory excluded"}, {"path": "logo.png", "reason": "static_asset"}]
        self.check("passed")
        self.inventory["warnings"] = ["Could not read an input file."]
        self.check("incomplete")

    def test_symlink_is_gap_even_when_path_contains_vendor(self):
        self.inventory["exclusions"] = [{"path": "vendor-important-page.html", "reason": "symbolic_link_file: not followed"}]
        self.check("incomplete")

    def test_empty_explicit_candidate_can_be_not_mock(self):
        empty_hash = hashlib.sha256(b"").hexdigest()
        (self.root / "mock-data/raw/empty.txt").write_bytes(b"")
        self.inventory["files"].append({"id": "F-0002", "path": "empty.txt", "sha256": empty_hash, "size": 0, "line_count": 0, "roles": ["source"]})
        self.inventory["mock_candidates"].append({"id": "MC-0002", "source_file": "F-0002", "path": "empty.txt", "reason": "explicit source", "line_start": 0, "line_end": 0, "snapshot": "mock-data/raw/empty.txt", "sha256": empty_hash})
        self.audit["file_reviews"].append({"file_id": "F-0002", "status": "not_applicable", "reason": "Empty file."})
        self.audit["mock_reviews"].append({"candidate_id": "MC-0002", "decision": "not_mock", "mock_ids": [], "reason": "Explicit source is empty."})
        self.check("passed")

    def test_utf16_line_count_is_not_overwritten_by_byte_splitlines(self):
        self.source = self.source.decode("utf-8").encode("utf-16")
        self.digest = hashlib.sha256(self.source).hexdigest()
        self.snapshot.write_bytes(self.source)
        self.inventory["files"][0].update(sha256=self.digest, size=len(self.source), encoding="utf-16 (BOM)")
        self.inventory["mock_candidates"][0]["sha256"] = self.digest
        self.audit["mocks"][0]["sha256"] = self.digest
        self.audit["evidence"][0]["line_end"] = 5
        self.check(error="超出快照/清单行数 4")
        self.audit["evidence"][0]["line_end"] = 4
        self.check("passed")

    def test_missing_review_document_is_error(self):
        self.save()
        (self.root / "review.md").unlink()
        report = MODULE.validate_output(self.root)
        self.assertEqual(report["status"], "failed")
        self.assertTrue(any("review.md" in error for error in report["errors"]))

    def test_malformed_json_and_top_level_type_return_reports(self):
        self.save()
        for text in ("{broken", "[]", "null"):
            with self.subTest(text=text):
                (self.root / "audit.json").write_text(text, encoding="utf-8")
                report = MODULE.validate_output(self.root)
                self.assertEqual(report["status"], "failed")
                self.assertTrue(report["errors"])

    def test_cli_codes_and_report_file(self):
        for state, expected in (("verified", 0), ("static_only", 2), ("illegal", 1)):
            with self.subTest(state=state):
                self.audit["pages"][0]["status"] = state
                self.save()
                with contextlib.redirect_stdout(io.StringIO()):
                    code = MODULE.main([str(self.root)])
                self.assertEqual(code, expected)
                self.assertEqual(json.loads((self.root / "verification.json").read_text())["status"], {0: "passed", 1: "failed", 2: "incomplete"}[expected])


if __name__ == "__main__":
    unittest.main()
