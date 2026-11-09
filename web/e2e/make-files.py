"""Builds the Excel files the end-to-end run uploads, from the API's own template.
Usage: python3 -I make-files.py template.xlsx outdir"""
import sys
import openpyxl

tpl, out = sys.argv[1], sys.argv[2]

def build(name, rows):
    wb = openpyxl.load_workbook(tpl)
    ws = wb["Debts"]
    # The import parser (exceljs) cannot read cell comments as openpyxl saves them,
    # so the header notes are removed. Files saved by Excel keep them without trouble.
    for row in ws.iter_rows():
        for cell in row:
            cell.comment = None
    for i, r in enumerate(rows, start=2):
        for col, value in r.items():
            ws.cell(row=i, column=col, value=value)
    wb.save(f"{out}/{name}")

# Columns: 1 ID type, 2 ID number, 3 full name, 5 phone 1, 8 language, 14 amount, 15 reason, 19 instrument, 20 instrument number
good = [
    {1: "Iqama", 2: "2400000011", 3: "Karim Import Demo", 5: "0551110001", 8: "Urdu", 14: 1200, 15: "Motorcycle rent, October", 19: "None"},
    {1: "Iqama", 2: "2400000011", 3: "Karim Import Demo", 5: "0551110001", 8: "Urdu", 14: 350.5, 15: "Fuel card", 19: "None"},
    {1: "National ID", 2: "1100000022", 3: "Sami Import Demo", 5: "551110002", 8: "Arabic", 14: 2000, 15: "Salary advance", 19: "Cheque", 20: "CHQ-7781"},
]
bad = [
    {1: "Iqama", 2: "2400000033", 3: "Broken Row Demo", 5: "0551110003", 14: None, 15: "No amount", 19: "None"},
    {1: "Iqama", 2: "2400000044", 3: "Short Phone Demo", 5: "05123", 14: 100, 15: "Phone too short", 19: "None"},
]
build("good.xlsx", good)
# A small real PDF for the document upload.
with open(f"{out}/note.pdf", "wb") as f:
    f.write(b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n")
build("bad.xlsx", bad)
