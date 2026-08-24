# MarkItDown preview fixtures

These small, public sample documents are used only by the opt-in
`MARKITDOWN_E2E=1` conversion smoke tests.

- `sample.docx`: `python-openxml/python-docx` test fixture, MIT
- `sample.pptx`: `scanny/python-pptx` test fixture, MIT
- `sample.xlsx`: `frictionlessdata/datasets` sample workbook, MIT
- `sample.xls`: `exeter-data-analytics/python-data` sample workbook
- `sample.msg`: `hexiongjiu/offline-filedesk` example message, Apache-2.0

The XLS source repository does not expose a machine-readable license marker;
the fixture is retained as a small public test sample and should be replaced
if its upstream redistribution terms change. The smoke suite is skipped unless
`MARKITDOWN_E2E=1` is explicitly set.
