#!/usr/bin/env python3
"""Post-process footers: Roman/arabic instrText switches + strip empty pgNumType (WPS compat)."""
import zipfile, shutil, re, sys, os

src = "/home/z/my-project/download/AgentPay-Pending-Work-and-Next-Steps.docx"
tmp = src + ".tmp"

with zipfile.ZipFile(src, "r") as zin:
    names = zin.namelist()
    items = {n: zin.read(n) for n in names}

# 1) strip empty pgNumType from document.xml (cover section)
doc = items["word/document.xml"].decode("utf-8")
doc2 = doc.replace("<w:pgNumType/>", "")
if doc2 != doc:
    print("removed empty pgNumType")
items["word/document.xml"] = doc2.encode("utf-8")

# 2) footer instrText: section2 footer (Roman) vs section3 footer (arabic).
# docx-js creates footer1.xml, footer2.xml... in section order.
# Identify by which section references which footer: parse document.xml sectPr order.
sect_footers = re.findall(r'<w:footerReference w:type="default" r:id="(rId\d+)"/>', doc2)
rels = items["word/_rels/document.xml.rels"].decode("utf-8")
rid_to_file = dict(re.findall(r'Id="(rId\d+)"[^>]*Target="(footer\d+\.xml)"', rels))
footer_files = [rid_to_file.get(r) for r in sect_footers if rid_to_file.get(r)]
print("footer order (TOC first, body second):", footer_files)

for idx, fname in enumerate(footer_files):
    key = f"word/{fname}"
    if key not in items:
        continue
    xml = items[key].decode("utf-8")
    fmt = "ROMAN" if idx == 0 else "arabic"
    xml2, n = re.subn(
        r'(<w:instrText[^>]*>)\s*PAGE\s*(</w:instrText>)',
        rf'\1 PAGE \\* {fmt} \\* MERGEFORMAT \2',
        xml)
    if n:
        print(f"{fname}: patched {n} PAGE field(s) -> {fmt}")
    items[key] = xml2.encode("utf-8")

with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
    for n in names:
        zout.writestr(n, items[n])
shutil.move(tmp, src)
print("post-process done")
