import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "inventory_demo.py"
SPEC = importlib.util.spec_from_file_location("inventory_demo", SCRIPT)
inventory = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inventory)


class InventoryTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "demo"
        self.source.mkdir()
        self.output = self.root / "result"

    def write(self, name, content):
        path = self.source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content if isinstance(content, bytes) else content.encode("utf-8"))
        return path

    def run_inventory(self, **kwargs):
        return inventory.inventory_demo(self.source, self.output, **kwargs)

    def test_mpa_and_all_document_candidates(self):
        self.write("index.html", '<ul><li>A</li><li>B</li></ul>')
        self.write("details.htm", '<div data-record-id="23">Details</div>')
        self.write("arbitrary.md", "复用用户模块。")
        self.write("notes/unusual.txt", "保存后返回列表。")
        self.write("guide.html", "<p>交互说明：双击编辑</p>")
        result = self.run_inventory()
        self.assertEqual(result["schema_version"], 1)
        self.assertEqual(len(result["entry_candidates"]), 3)
        self.assertEqual(len(result["document_candidates"]), 5)
        self.assertEqual(len(result["files"]), 5)
        self.assertEqual({item["path"] for item in result["mock_candidates"]}, {"index.html", "details.htm"})
        self.assertEqual(result, json.loads((self.output / "inventory.json").read_text()))
        self.assertEqual(result["warnings"], [])
        self.assertEqual(len(result["limitations"]), 2)
        self.assertTrue(all(item["file_id"].startswith("F-") for item in result["entry_candidates"] + result["document_candidates"]))

    def test_react_vue_spa_and_metadata_not_mock(self):
        self.write("package.json", json.dumps({"scripts": {"dev": "vite"}, "dependencies": {"react": "x", "vue": "x"}}))
        self.write("index.html", '<div id="root"></div>')
        self.write("src/App.tsx", 'const rows: Row[] = [\n  {name: "A"},\n  {name: "B"},\n];\nexport default function App() { return null; }')
        self.write("src/View.vue", '<script setup>\nconst options = ref([{label: "All"}]);\n</script>')
        self.write("tsconfig.app.json", '{"compilerOptions":{"strict":true}}')
        self.write("package-lock.json", '{"packages":{}}')
        result = self.run_inventory()
        metadata = next(item for item in result["entry_candidates"] if item["kind"] == "package_metadata")
        self.assertEqual(metadata["framework_hints"], ["react", "vue"])
        self.assertEqual(metadata["script_names"], ["dev"])
        paths = {item["path"] for item in result["mock_candidates"]}
        self.assertEqual(paths, {"src/App.tsx", "src/View.vue"})
        app = next(item for item in result["mock_candidates"] if item["path"] == "src/App.tsx")
        self.assertEqual((app["line_start"], app["line_end"]), (1, 4))

    def test_snapshots_preserve_non_utf8_bytes_and_deduplicate(self):
        raw = 'const data = [{name: "中文"}];\r\n'.encode("gb18030")
        self.write("mock-data.js", raw)
        result = self.run_inventory()
        self.assertGreaterEqual(len(result["mock_candidates"]), 2)
        for candidate in result["mock_candidates"]:
            saved = (self.output / candidate["snapshot"]).read_bytes()
            self.assertEqual(saved, raw)
            self.assertEqual(candidate["sha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual(result["files"][0]["size"], len(raw))
        self.assertEqual(len(list((self.output / "mock-data/raw").iterdir())), 1)
        self.assertTrue(any("gb18030" in item for item in result["warnings"]))

    def test_utf16_inline_json(self):
        raw = '<script type="application/json">\n{"name":"测试"}\n</script>'.encode("utf-16")
        self.write("index.html", raw)
        result = self.run_inventory()
        self.assertTrue(any("inline JSON" in item["reason"] for item in result["mock_candidates"]))
        self.assertEqual((self.output / "mock-data/raw/index.html").read_bytes(), raw)
        self.assertEqual(result["files"][0]["line_count"], 3)
        self.assertEqual(result["warnings"], [])

    def test_empty_explicit_snapshot_has_zero_line_span(self):
        self.write("blank.txt", b"")
        result = self.run_inventory(include_source=["blank.txt"])
        self.assertEqual(result["files"][0]["line_count"], 0)
        candidate = result["mock_candidates"][0]
        self.assertEqual((candidate["line_start"], candidate["line_end"]), (0, 0))
        self.assertEqual((self.output / candidate["snapshot"]).read_bytes(), b"")

    def test_cr_newlines_and_trailing_linefeed_match_splitlines(self):
        self.write("main.js", 'const rows = [\r  {name:"A"},\r  {name:"B"}\r];\r')
        result = self.run_inventory()
        self.assertEqual(result["files"][0]["line_count"], 4)
        candidate = result["mock_candidates"][0]
        self.assertEqual((candidate["line_start"], candidate["line_end"]), (1, 4))

    def test_missing_explicit_path_is_visible(self):
        self.write("index.html", "<p>Hello</p>")
        result = self.run_inventory(include_source=["missing.js"])
        self.assertTrue(any("Explicit source was not included" in item and "missing.js" in item for item in result["warnings"]))

    def test_symlinks_are_logged_and_not_followed(self):
        external = self.root / "outside.json"
        external.write_text('{"private":true}')
        (self.source / "data.json").symlink_to(external)
        (self.source / "linked-dir").symlink_to(self.root, target_is_directory=True)
        result = self.run_inventory(include_source=["data.json"])
        self.assertEqual(result["files"], [])
        self.assertEqual({item["path"] for item in result["exclusions"]}, {"data.json", "linked-dir"})
        self.assertTrue(any("Explicit source was not included" in item for item in result["warnings"]))

    def test_output_overlap_and_existing_directory_are_rejected(self):
        self.write("index.html", "hello")
        for output in (self.source, self.source / "result", self.root):
            with self.subTest(output=output), self.assertRaises(ValueError):
                inventory.inventory_demo(self.source, output)
        self.output.mkdir()
        marker = self.output / "keep.txt"
        marker.write_text("keep")
        with self.assertRaises(ValueError):
            self.run_inventory()
        self.assertEqual(marker.read_text(), "keep")
        self.assertFalse((self.source / "result").exists())

    def test_symlink_output_ancestor_cannot_hide_overlap(self):
        alias = self.root / "alias"
        alias.symlink_to(self.source, target_is_directory=True)
        with self.assertRaises(ValueError):
            inventory.inventory_demo(self.source, alias / "result")

    def test_explicit_source_recovers_missed_literals_and_unknown_extension(self):
        self.write("src/prices.js", 'const price = "120.00";')
        self.write("data.records", "Alpha|Beta")
        self.write("data.json", '{"items":[1,2]}')
        result = self.run_inventory(include_source=["src/prices.js", "data.records"])
        self.assertEqual({item["path"] for item in result["mock_candidates"]}, {"src/prices.js", "data.records", "data.json"})
        self.assertTrue((self.output / "mock-data/raw/data.records").exists())

    def test_invalid_explicit_source_rejected_before_output(self):
        for source in ("../outside.json", "/tmp/outside.json", ""):
            with self.subTest(source=source), self.assertRaises(ValueError):
                self.run_inventory(include_source=[source])
        self.assertFalse(self.output.exists())

    def test_excluded_directories_and_generated_opt_in(self):
        for name in ("node_modules", ".git", ".venv", "vendor", ".next", "dist", "build"):
            self.write(name + "/index.html", '<select><option>A</option><option>B</option></select>')
        result = self.run_inventory(include_source=["node_modules/index.html"])
        self.assertEqual(result["files"], [])
        self.assertEqual(len(result["exclusions"]), 7)
        result = inventory.inventory_demo(self.source, self.root / "generated-result", include_generated=True)
        self.assertEqual({item["path"] for item in result["files"]}, {"dist/index.html", "build/index.html"})
        self.assertEqual(len(result["exclusions"]), 5)

    def test_static_assets_are_distinguished_from_unknown_file_types(self):
        self.write("index.html", '<img src="assets/logo.png">')
        self.write("assets/logo.png", b"\x89PNG\r\n\x1a\n")
        self.write("assets/icon.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>')
        self.write("assets/labels.records", "Needs manual classification")
        result = self.run_inventory()
        reasons = {item["path"]: item["reason"] for item in result["exclusions"]}
        self.assertEqual(reasons["assets/logo.png"], "static_asset")
        self.assertEqual(reasons["assets/icon.svg"], "static_asset")
        self.assertEqual(reasons["assets/labels.records"], "unsupported_file_type")
        self.assertEqual(result["warnings"], [])

    def test_read_errors_are_visible(self):
        self.write("index.html", "hello")
        with mock.patch.object(inventory, "read_regular_file", side_effect=PermissionError("denied")):
            result = self.run_inventory()
        self.assertEqual(result["files"], [])
        self.assertTrue(result["exclusions"][0]["reason"].startswith("file_read_error"))
        self.assertTrue(any("Could not read file" in item for item in result["warnings"]))

    def test_deterministic_ids_and_cli(self):
        self.write("z.txt", "Z")
        self.write("a/index.html", '<ol><li>A</li><li>B</li></ol>')
        completed = subprocess.run([sys.executable, str(SCRIPT), str(self.source), "--output", str(self.output), "--include-source", "z.txt"], capture_output=True, text=True)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = json.loads((self.output / "inventory.json").read_text())
        self.assertEqual([(item["id"], item["path"]) for item in result["files"]], [("F-0001", "a/index.html"), ("F-0002", "z.txt")])
        self.assertEqual(json.loads(completed.stdout)["files"], 2)
        repeated = subprocess.run([sys.executable, str(SCRIPT), str(self.source), "--output", str(self.output)], capture_output=True, text=True)
        self.assertEqual(repeated.returncode, 2)
        self.assertIn("refusing to overwrite", repeated.stderr)


if __name__ == "__main__":
    unittest.main()
