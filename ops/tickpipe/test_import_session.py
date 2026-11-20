import tempfile
import unittest
from pathlib import Path

from import_session import NS, build, publish


class ImportTests(unittest.TestCase):
    def test_ohlc_gaps_and_order(self):
        rows = [
            (NS, NS - 1, "NFO:NIFTY", 1, 100, 0, None),
            (NS + 5, None, "NFO:NIFTY", 2, 99, 2, 20),
            (2 * NS, None, "NFO:OTHER", 3, 1, 1, None),
            (4 * NS, None, "NFO:NIFTY", 5, 101, 1, 21),
        ]
        result = build(rows, "NFO:NIFTY", 0)
        self.assertEqual(result, build(rows, "NFO:NIFTY", 0))
        self.assertEqual(result["sequence_gaps"], [["4", "4"]])
        self.assertEqual([bar["time"] for bar in result["candles"]["1"]], [1, 4])
        self.assertEqual(result["candles"]["60"], [
            {"time": 0, "open": 100, "high": 101, "low": 99, "close": 101}
        ])
        self.assertEqual(result["ticks"][0][:3], [str(NS), str(NS - 1), "1"])
        with self.assertRaises(ValueError):
            build(rows + rows, "NFO:NIFTY", 0)

    def test_idempotent_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first = publish(root, "session.json", {"a": 1})
            self.assertEqual(publish(root, "session.json", {"a": 1}), first)
            with self.assertRaises(ValueError):
                publish(root, "session.json", {"a": 2})
            self.assertEqual(first.read_text(), '{"a":1}\n')
