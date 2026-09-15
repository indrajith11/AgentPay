#!/usr/bin/env python3
"""Charts for MerchantPilot Judge's Audit document (English labels).
Palette: DM-1 derived — accent #1B6B7A, dark navy #0A1628, neutral greys."""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import os

OUT = "/home/z/my-project/research/advanced"
os.makedirs(OUT, exist_ok=True)

ACCENT = "#1B6B7A"
NAVY = "#0A1628"
GREY = "#9AA6B2"
RED = "#B0533A"
GOLD = "#B08A3E"

plt.rcParams.update({
    "font.family": "sans-serif",
    "font.sans-serif": ["DejaVu Sans"],
    "axes.edgecolor": "#C9CFD6",
    "axes.labelcolor": NAVY,
    "text.color": NAVY,
    "xtick.color": "#506070",
    "ytick.color": "#506070",
    "axes.titlesize": 13,
    "axes.titleweight": "bold",
})

# ---------- Chart 1: Judging scorecard — today vs achievable ----------
crit = ["Innovation\n30%", "Technical\n25%", "User\nExperience 15%", "Mainnet\nIntegration 15%", "Business\nPotential 15%"]
today = [6.5, 7.0, 5.0, 0.0, 7.0]
achievable = [8.5, 8.5, 7.5, 9.0, 8.0]

x = np.arange(len(crit))
w = 0.36
fig, ax = plt.subplots(figsize=(8.6, 4.2), dpi=200, constrained_layout=True)
b1 = ax.bar(x - w/2, today, w, label="Scored today (evidence-based)", color=GREY, edgecolor="white")
b2 = ax.bar(x + w/2, achievable, w, label="Achievable by Nov 30 (if plan executes)", color=ACCENT, edgecolor="white")
for bars in (b1, b2):
    for b in bars:
        ax.annotate(f"{b.get_height():.1f}", (b.get_x() + b.get_width()/2, b.get_height()),
                    textcoords="offset points", xytext=(0, 3), ha="center", fontsize=9, color=NAVY)
ax.set_ylim(0, 10.6)
ax.set_ylabel("Judge score (0-10)")
ax.set_title("Figure 1  Weighted scorecard: scored today vs achievable", loc="left", pad=10)
ax.set_xticks(x); ax.set_xticklabels(crit, fontsize=9)
ax.spines[["top", "right"]].set_visible(False)
ax.yaxis.grid(True, color="#E4E8EC", linewidth=0.8); ax.set_axisbelow(True)
ax.legend(loc="upper left", bbox_to_anchor=(0.28, -0.16), ncol=2, frameon=False, fontsize=9)
fig.savefig(f"{OUT}/chart_scorecard.png")
plt.close(fig)

# ---------- Chart 2: Cost & settlement comparison vs incumbents ----------
labels = ["BitPay\n(fiat settlement)", "Coinbase\nCommerce", "Transak\n(off-ramp widget)", "MerchantPilot\non QIE"]
fees = [1.5, 1.0, 1.75, 1.0]          # % midpoint of documented ranges
fee_lo = [1.0, 1.0, 1.0, 0.5]
fee_hi = [2.0, 1.0, 2.5, 1.0]
settle_h = [24, 36, 2, 0.5]           # hours to merchant fiat/bank, documented ranges' midpoints

fig, (axL, axR) = plt.subplots(1, 2, figsize=(8.6, 3.9), dpi=200, constrained_layout=True)
y = np.arange(len(labels))
colors = [GREY, GREY, GREY, ACCENT]
err = np.array([[f - l for f, l in zip(fees, fee_lo)], [h - f for f, h in zip(fees, fee_hi)]])
bars = axL.barh(y, fees, xerr=err, color=colors, edgecolor="white", height=0.62,
                error_kw={"ecolor": NAVY, "elinewidth": 1.2, "capsize": 3})
axL.set_yticks(y); axL.set_yticklabels(labels, fontsize=8.5)
axL.invert_yaxis()
axL.set_xlabel("Total fee to merchant (%)")
axL.set_title("Fees (documented ranges)", loc="left", fontsize=11)
axL.spines[["top", "right"]].set_visible(False)
axL.xaxis.grid(True, color="#E4E8EC", linewidth=0.8); axL.set_axisbelow(True)
for b, lo, hi in zip(bars, fee_lo, fee_hi):
    axL.annotate(f"{lo:.1f}-{hi:.1f}%", (b.get_width(), b.get_y() + b.get_height()/2),
                 textcoords="offset points", xytext=(26 if b is bars[0] else 8, -3), fontsize=8.5, color=NAVY)

bars2 = axR.barh(y, settle_h, color=colors, edgecolor="white", height=0.62)
axR.set_yticks(y); axR.set_yticklabels([""] * len(labels))
axR.invert_yaxis()
axR.set_xlabel("Hours until merchant receives value (indicative midpoint)")
axR.set_title("Settlement latency", loc="left", fontsize=11)
axR.spines[["top", "right"]].set_visible(False)
axR.xaxis.grid(True, color="#E4E8EC", linewidth=0.8); axR.set_axisbelow(True)
for b, h, txt in zip(bars2, settle_h, ["next business day", "24-48 h", "~1-2 h", "on-chain 1-2 s;\nbank leg provider-dependent"]):
    axR.annotate(txt, (0.15, b.get_y() + b.get_height()/2), textcoords="offset points",
                 xytext=(6, -3), fontsize=7.6, color="white" if h > 3 else NAVY)
axR.set_xlim(0, 42)

fig.suptitle("Figure 2  MerchantPilot position vs incumbent processors (documented public figures)", x=0.005, ha="left", fontsize=12.5, fontweight="bold")
fig.savefig(f"{OUT}/chart_fees.png")
plt.close(fig)

print("charts done:", os.listdir(OUT))
