#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build the body PDF for the AgentPay x MerchantPilot 10/10 Master Plan.
Route: Report (ReportLab) per skills/pdf/briefs/report.md.
- TocDocTemplate + multiBuild (document has TOC)
- Template 07 Crystal Blue fixed body palette
- install_font_fallback, Paragraph-wrapped table cells, safe_keep_together,
  CondPageBreak orphan guards, page background + header/footer."""
import os, sys, hashlib
PROJECT = '/home/z/my-project'
PDF_SKILL_DIR = os.path.join(PROJECT, 'skills', 'pdf')
sys.path.insert(0, os.path.join(PDF_SKILL_DIR, 'scripts'))
sys.path.insert(0, os.path.join(PROJECT, 'scripts'))

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY, TA_RIGHT
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, PageBreak,
                                Table, TableStyle, Image, KeepTogether, CondPageBreak,
                                HRFlowable)
from reportlab.platypus.tableofcontents import TableOfContents
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase.pdfmetrics import registerFontFamily
from PIL import Image as PILImage

# -- Fonts (report.md registration template) --------------------------------
FONT_DIR = '/usr/share/fonts'
pdfmetrics.registerFont(TTFont('NotoSerifSC', f'{FONT_DIR}/truetype/noto-serif-sc/NotoSerifSC-Regular.ttf'))
pdfmetrics.registerFont(TTFont('NotoSerifSC-Bold', f'{FONT_DIR}/truetype/noto-serif-sc/NotoSerifSC-Bold.ttf'))
pdfmetrics.registerFont(TTFont('Noto Sans SC', f'{FONT_DIR}/truetype/noto-serif-sc/NotoSerifSC-Regular.ttf'))
pdfmetrics.registerFont(TTFont('Noto Sans SC Bold', f'{FONT_DIR}/truetype/noto-serif-sc/NotoSerifSC-Bold.ttf'))
pdfmetrics.registerFont(TTFont('FreeSerif', f'{FONT_DIR}/truetype/freefont/FreeSerif.ttf'))
pdfmetrics.registerFont(TTFont('FreeSerif-Bold', f'{FONT_DIR}/truetype/freefont/FreeSerifBold.ttf'))
pdfmetrics.registerFont(TTFont('FreeSerif-Italic', f'{FONT_DIR}/truetype/freefont/FreeSerifItalic.ttf'))
pdfmetrics.registerFont(TTFont('FreeSerif-BoldItalic', f'{FONT_DIR}/truetype/freefont/FreeSerifBoldItalic.ttf'))
pdfmetrics.registerFont(TTFont('DejaVuSans', f'{FONT_DIR}/truetype/dejavu/DejaVuSansMono.ttf'))
registerFontFamily('NotoSerifSC', normal='NotoSerifSC', bold='NotoSerifSC-Bold')
registerFontFamily('Noto Sans SC', normal='Noto Sans SC', bold='Noto Sans SC Bold')
registerFontFamily('FreeSerif', normal='FreeSerif', bold='FreeSerif-Bold',
                   italic='FreeSerif-Italic', boldItalic='FreeSerif-BoldItalic')
registerFontFamily('DejaVuSans', normal='DejaVuSans', bold='DejaVuSans')

from pdf import install_font_fallback
install_font_fallback()

# -- Template 07 Crystal Blue body palette ------------------------------------
PAGE_BG      = colors.HexColor('#f5f8fc')
SECTION_BG   = colors.HexColor('#edf2f9')
CARD_BG      = colors.HexColor('#e4ecf5')
TABLE_STRIPE = colors.HexColor('#eef3fa')
HEADER_FILL  = colors.HexColor('#1a4a7a')
BORDER       = colors.HexColor('#c0d0e2')
ACCENT       = colors.HexColor('#2d7ab3')
TEXT_PRIMARY = colors.HexColor('#142840')
TEXT_MUTED   = colors.HexColor('#5a7a96')
TABLE_HEADER_COLOR = HEADER_FILL
TABLE_ROW_EVEN     = colors.white
TABLE_ROW_ODD      = TABLE_STRIPE

# -- Geometry ------------------------------------------------------------------
MARGIN = 0.9 * inch
TOP_M, BOT_M = 0.95 * inch, 0.85 * inch
PAGE_W, PAGE_H = A4
AVAIL_W = PAGE_W - 2 * MARGIN
AVAIL_H = PAGE_H - TOP_M - BOT_M
H1_ORPHAN = AVAIL_H * 0.25
MAX_KEEP = PAGE_H * 0.4

DOC_TITLE = 'The 10/10 Master Plan - AgentPay x MerchantPilot on QIE (Hackathon 3.0, Track 04)'
AUTHOR = 'Z.ai'

# -- Styles ---------------------------------------------------------------------
S = {}
S['body'] = ParagraphStyle('Body', fontName='FreeSerif', fontSize=10.5, leading=17,
                           alignment=TA_JUSTIFY, textColor=TEXT_PRIMARY,
                           spaceBefore=0, spaceAfter=8)
S['bullet'] = ParagraphStyle('Bullet', parent=S['body'], alignment=TA_LEFT,
                             leftIndent=16, bulletIndent=4, spaceAfter=4)
S['h1'] = ParagraphStyle('H1', fontName='FreeSerif', fontSize=20, leading=25,
                         textColor=TEXT_PRIMARY, spaceBefore=22, spaceAfter=4)
S['h2'] = ParagraphStyle('H2', fontName='FreeSerif', fontSize=14.5, leading=19,
                         textColor=HEADER_FILL, spaceBefore=16, spaceAfter=6)
S['h3'] = ParagraphStyle('H3', fontName='FreeSerif', fontSize=11.5, leading=15.5,
                         textColor=TEXT_PRIMARY, spaceBefore=12, spaceAfter=5)
S['caption'] = ParagraphStyle('Caption', fontName='FreeSerif', fontSize=8.5, leading=11.5,
                              alignment=TA_CENTER, textColor=TEXT_MUTED,
                              spaceBefore=3, spaceAfter=6)
S['quote'] = ParagraphStyle('Quote', fontName='FreeSerif-Italic', fontSize=10.5,
                            leading=16.5, leftIndent=10, textColor=HEADER_FILL,
                            alignment=TA_LEFT)
S['th'] = ParagraphStyle('TH', fontName='FreeSerif', fontSize=9.5, leading=12.5,
                         textColor=colors.white, alignment=TA_CENTER)
S['td'] = ParagraphStyle('TD', fontName='FreeSerif', fontSize=9.5, leading=12.5,
                         textColor=TEXT_PRIMARY, alignment=TA_LEFT)
S['td_c'] = ParagraphStyle('TDC', parent=S['td'], alignment=TA_CENTER)
S['stat'] = ParagraphStyle('Stat', fontName='FreeSerif', fontSize=17, leading=20,
                           textColor=ACCENT, alignment=TA_CENTER)
S['stat_label'] = ParagraphStyle('StatL', fontName='FreeSerif', fontSize=7.5, leading=9.5,
                                 textColor=TEXT_MUTED, alignment=TA_CENTER)
S['toc0'] = ParagraphStyle('TOC0', fontName='FreeSerif', fontSize=11.5, leading=21,
                           textColor=TEXT_PRIMARY, leftIndent=6)
S['toc1'] = ParagraphStyle('TOC1', fontName='FreeSerif', fontSize=10, leading=17,
                           textColor=TEXT_MUTED, leftIndent=22)
S['toc_title'] = ParagraphStyle('TOCTitle', fontName='FreeSerif', fontSize=20, leading=25,
                                textColor=TEXT_PRIMARY, spaceAfter=14)

# -- TOC machinery (report.md TOC gate) ------------------------------------------
class TocDocTemplate(SimpleDocTemplate):
    def afterFlowable(self, flowable):
        if hasattr(flowable, 'bookmark_name'):
            level = getattr(flowable, 'bookmark_level', 0)
            text = getattr(flowable, 'bookmark_text', '')
            key = getattr(flowable, 'bookmark_key', '')
            self.notify('TOCEntry', (level, text, self.page - 1, key))

def add_heading(text, style, level=0):
    key = 'h_%s' % hashlib.md5(text.encode()).hexdigest()[:8]
    p = Paragraph('<a name="%s"/><b>%s</b>' % (key, text), style)
    p.bookmark_name = key
    p.bookmark_level = level
    p.bookmark_text = text
    p.bookmark_key = key
    return p

# -- Helpers ----------------------------------------------------------------------
def wrap_h(el):
    try:
        w, h = el.wrap(AVAIL_W, PAGE_H)
        return h
    except Exception:
        return 0

def safe_keep_together(elements):
    total = sum(wrap_h(e) for e in elements)
    if total <= MAX_KEEP:
        return [KeepTogether(elements)]
    elif len(elements) >= 2:
        return [KeepTogether(elements[:2])] + list(elements[2:])
    return list(elements)

def embed_image(path, max_width=AVAIL_W, max_height=290):
    pil = PILImage.open(path)
    ow, oh = pil.size
    ratio = min(max_width / ow if ow > max_width else 1.0,
                max_height / oh if oh > max_height else 1.0)
    return Image(path, width=ow * ratio, height=oh * ratio)

def make_table(header, rows, ratios):
    col_w = [r * AVAIL_W for r in ratios]
    assert sum(col_w) <= AVAIL_W + 0.5, 'table overflow: %.1f > %.1f' % (sum(col_w), AVAIL_W)
    data = [[Paragraph('<b>%s</b>' % h, S['th']) for h in header]]
    for row in rows:
        cells = [Paragraph(str(cell), S['td']) for cell in row]
        data.append(cells)
    t = Table(data, colWidths=col_w, hAlign='CENTER', repeatRows=1)
    style = [
        ('BACKGROUND', (0, 0), (-1, 0), TABLE_HEADER_COLOR),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('GRID', (0, 0), (-1, -1), 0.5, BORDER),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), 7),
        ('RIGHTPADDING', (0, 0), (-1, -1), 7),
        ('TOPPADDING', (0, 0), (-1, -1), 5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
    ]
    for ri in range(1, len(data)):
        style.append(('BACKGROUND', (0, ri), (-1, ri),
                      TABLE_ROW_EVEN if ri % 2 == 1 else TABLE_ROW_ODD))
    t.setStyle(TableStyle(style))
    return t

def make_callouts(items):
    n = len(items)
    gap = 9
    bw = (AVAIL_W - gap * (n - 1)) / n
    cells, widths = [], []
    for i, (stat, label) in enumerate(items):
        inner = Table([[Paragraph('<b>%s</b>' % stat, S['stat'])],
                       [Paragraph(label, S['stat_label'])]], colWidths=[bw])
        inner.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), CARD_BG),
            ('BOX', (0, 0), (-1, -1), 1, ACCENT),
            ('TOPPADDING', (0, 0), (-1, 0), 8),
            ('BOTTOMPADDING', (0, -1), (-1, -1), 8),
            ('TOPPADDING', (0, 1), (-1, 1), 2),
            ('BOTTOMPADDING', (0, 0), (-1, 0), 2),
            ('LEFTPADDING', (0, 0), (-1, -1), 4),
            ('RIGHTPADDING', (0, 0), (-1, -1), 4),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ]))
        cells.append(inner)
        widths.append(bw)
        if i < n - 1:
            cells.append('')
            widths.append(gap)
    outer = Table([cells], colWidths=widths, hAlign='CENTER')
    outer.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (-1, -1), 0),
        ('TOPPADDING', (0, 0), (-1, -1), 0),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
    ]))
    return outer

def make_quote(text):
    t = Table([[Paragraph(text, S['quote'])]], colWidths=[AVAIL_W * 0.92], hAlign='CENTER')
    t.setStyle(TableStyle([
        ('LINEBEFORE', (0, 0), (0, -1), 2, ACCENT),
        ('BACKGROUND', (0, 0), (-1, -1), SECTION_BG),
        ('LEFTPADDING', (0, 0), (-1, -1), 12),
        ('RIGHTPADDING', (0, 0), (-1, -1), 10),
        ('TOPPADDING', (0, 0), (-1, -1), 8),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
    ]))
    return t

# -- Block -> flowable conversion ---------------------------------------------------
def block_to_flowables(b, story):
    t = b['t']
    if t == 'h1':
        story.append(CondPageBreak(H1_ORPHAN))
        h = add_heading(b['text'], S['h1'], level=0)
        rule = HRFlowable(width='100%', thickness=1.2, color=ACCENT,
                          spaceBefore=0, spaceAfter=10)
        story.append(KeepTogether([h, rule]))
    elif t == 'h2':
        story.append(CondPageBreak(AVAIL_H * 0.12))
        story.append(add_heading(b['text'], S['h2'], level=1))
    elif t == 'h3':
        story.append(Paragraph('<b>%s</b>' % b['text'], S['h3']))
    elif t == 'p':
        story.append(Paragraph(b['text'], S['body']))
    elif t == 'bullet':
        for it in b['items']:
            story.append(Paragraph(it, S['bullet'], bulletText='\u2022'))
        story.append(Spacer(1, 4))
    elif t == 'numbered':
        for i, it in enumerate(b['items'], 1):
            story.append(Paragraph('%d. %s' % (i, it), S['bullet']))
        story.append(Spacer(1, 4))
    elif t == 'callouts':
        story.append(Spacer(1, 8))
        story.append(make_callouts(b['items']))
        story.append(Spacer(1, 12))
    elif t == 'table':
        story.append(Spacer(1, 14))
        tbl = make_table(b['header'], b['rows'], b['ratios'])
        cap = Paragraph(b.get('title', ''), S['caption']) if b.get('title') else None
        if len(b['rows']) <= 15 and cap:
            story.extend(safe_keep_together([tbl, Spacer(1, 5), cap]))
        elif cap:
            story.append(tbl)
            story.append(Spacer(1, 5))
            story.append(cap)
        else:
            story.append(tbl)
        story.append(Spacer(1, 12))
    elif t == 'chart':
        path = os.path.join(PROJECT, b['path'])
        max_h = b.get('max_h', 290)
        img = embed_image(path, AVAIL_W, max_h)
        cap = Paragraph(b['caption'], S['caption'])
        story.append(Spacer(1, 16))
        if b.get('keep', True):
            story.extend(safe_keep_together([img, Spacer(1, 6), cap]))
        else:
            story.append(img)
            story.append(Spacer(1, 6))
            story.append(cap)
        story.append(Spacer(1, 14))
    elif t == 'quote':
        story.append(Spacer(1, 8))
        story.append(make_quote(b['text']))
        story.append(Spacer(1, 10))
    elif t == 'spacer':
        story.append(Spacer(1, b.get('h', 10)))

# -- Page decorations ---------------------------------------------------------------
def paint_bg(canvas):
    canvas.saveState()
    canvas.setFillColor(PAGE_BG)
    canvas.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    canvas.restoreState()

def on_toc_page(canvas, doc):
    paint_bg(canvas)
    canvas.saveState()
    canvas.setFont('FreeSerif', 9)
    canvas.setFillColor(TEXT_MUTED)
    canvas.drawCentredString(PAGE_W / 2, 0.5 * inch, 'i')
    canvas.restoreState()

def on_content_page(canvas, doc):
    paint_bg(canvas)
    canvas.saveState()
    canvas.setFont('FreeSerif', 7.5)
    canvas.setFillColor(TEXT_MUTED)
    canvas.drawString(MARGIN, PAGE_H - 0.62 * inch, DOC_TITLE)
    canvas.setStrokeColor(ACCENT)
    canvas.setLineWidth(1.2)
    canvas.line(MARGIN, PAGE_H - 0.70 * inch, PAGE_W - MARGIN, PAGE_H - 0.70 * inch)
    canvas.setStrokeColor(BORDER)
    canvas.setLineWidth(0.5)
    canvas.line(MARGIN, 0.68 * inch, PAGE_W - MARGIN, 0.68 * inch)
    canvas.setFont('FreeSerif', 7.5)
    canvas.setFillColor(TEXT_MUTED)
    canvas.drawString(MARGIN, 0.5 * inch, 'Prepared with Z.ai')
    canvas.drawRightString(PAGE_W - MARGIN, 0.5 * inch, str(doc.page - 1))
    canvas.restoreState()

# -- Build ----------------------------------------------------------------------------
def main():
    from plan_content_a import PART1
    from plan_content_b import PART2
    from plan_content_c import PART3
    blocks = PART1 + PART2 + PART3

    out = os.path.join(PROJECT, 'research', 'plan_body.pdf')
    doc = TocDocTemplate(out, pagesize=A4,
                         leftMargin=MARGIN, rightMargin=MARGIN,
                         topMargin=TOP_M, bottomMargin=BOT_M,
                         title=DOC_TITLE, author=AUTHOR, creator='Z.ai',
                         subject='77-day master plan: every feature, every flow, contract security, cost plan and judge runbook to take the QIE Track 04 submission from 8.2 to the winning bar')

    story = []
    story.append(Paragraph('<b>Table of Contents</b>', S['toc_title']))
    toc = TableOfContents()
    toc.levelStyles = [S['toc0'], S['toc1']]
    story.append(toc)
    story.append(PageBreak())

    for b in blocks:
        block_to_flowables(b, story)

    doc.multiBuild(story, onFirstPage=on_toc_page, onLaterPages=on_content_page)
    print('plan_body.pdf built:', out)

if __name__ == '__main__':
    main()
