"""对真实成交明细做分组诊断（只读 CSV，不写库）"""
import sys, math
import pandas as pd
import numpy as np

CSV = r"D:/UGit/nofx-new/.workbuddy/runs/20260911-crypto-viability/05_statistical_audit/trade_detail.csv"
df = pd.read_csv(CSV)
df['ret'] = df['net'] / df['margin']
df['exit_iso'] = pd.to_datetime(df['exit_iso'])
df['day'] = df['exit_iso'].dt.date


def stats(g, label):
    n = len(g)
    if n == 0:
        print(f"{label:<28} n=0")
        return
    r = g['ret'].values
    mean, sd = r.mean(), r.std(ddof=1) if n > 1 else 0.0
    sr = mean / sd if sd > 0 else float('nan')
    # t 统计量（H0: 期望收益=0）
    t = mean / (sd / math.sqrt(n)) if sd > 0 else float('nan')
    print(f"{label:<28} n={n:<5} 胜率={100*(g['net']>0).mean():5.1f}%  净={g['net'].sum():9.2f}U  "
          f"均单={g['net'].mean():7.3f}U  逐笔Sharpe={sr:7.4f}  t={t:6.2f}")


print("=" * 118)
print("真实成交分组诊断（数据源：PostgreSQL simulated_orders，仅 status=closed 且 margin>0）")
print("=" * 118)
print(f"样本区间 {df['exit_iso'].min()} ~ {df['exit_iso'].max()}")
print(f"总成交 {len(df)} 笔\n")

stats(df, "【全样本】")
print()
for d, g in df.groupby('direction'):
    stats(g, f"方向 {d}")
print()
print("--- 按平仓原因 ---")
for r_, g in df.sort_values('reason').groupby('reason'):
    stats(g, f"{r_}")
print()
print("--- 按日 ---")
for d, g in df.groupby('day'):
    stats(g, f"{d}")
print()
print("--- 按持仓时长 ---")
bins = [0, 5, 15, 30, 45, 60, 120, 10**9]
labels = ['<5', '5-14', '15-29', '30-44', '45-59', '60-119', '>=120']
df['hold_bucket'] = pd.cut(df['held_bars'], bins=bins, labels=labels, right=False)
for b, g in df.groupby('hold_bucket', observed=True):
    stats(g, f"持仓 {b} 根")
print()
print("--- 仅多单（禁空口径）按平仓原因 ---")
lo = df[df['direction'] == 'OPEN_LONG']
for r_, g in lo.groupby('reason'):
    stats(g, f"LONG/{r_}")
