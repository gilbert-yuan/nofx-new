"""
Deflated Sharpe Ratio 检验（Bailey & López de Prado 2014）
对 4h 上表现最好的入场配置做多重检验校正。

为什么需要：我在 4h 上搜索了 10 个（入场×出场）配置，挑出最好的一个。
即使所有配置都是纯噪声，10 次试验里最好的那个也会表现出可观的 t 值。
DSR 回答的是：在做了 N 次试验的前提下，这个最好结果的 Sharpe 是否仍然显著？
"""
import csv, math, os, sys
from statistics import mean, pstdev

OUT = os.path.join(os.path.dirname(__file__), '..', '.workbuddy', 'runs',
                   '20260911-crypto-viability', '08_interval_backtest')
FILES = [
    ('E1_trend', 'stop2_tp3_trail'), ('E1_trend', 'stop3_tp3_trail'),
    ('E2_pullback', 'stop2_tp3_trail'), ('E2_pullback', 'stop3_tp3_trail'),
    ('E3_breakout', 'stop2_tp3_trail'), ('E3_breakout', 'stop3_tp3_trail'),
    ('E4_oversold_bounce', 'stop2_tp3_trail'), ('E4_oversold_bounce', 'stop3_tp3_trail'),
    ('E5_vol_expand', 'stop2_tp3_trail'), ('E5_vol_expand', 'stop3_tp3_trail'),
]

def norm_cdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))

def norm_ppf(p):
    # Acklam 近似，足够精确
    a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
         1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
    b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
         6.680131188771972e+01, -1.328068155288572e+01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
         -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
         3.754408661907416e+00]
    pl, ph = 0.02425, 1 - 0.02425
    if p < pl:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    if p > ph:
        q = math.sqrt(-2 * math.log(1-p))
        return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    q = p - 0.5; r = q*q
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1)

def moments(xs):
    n = len(xs); m = mean(xs)
    sd = pstdev(xs) if n > 1 else 0.0
    if sd == 0: return m, sd, 0.0, 3.0
    s = sum(((x-m)/sd)**3 for x in xs)/n
    k = sum(((x-m)/sd)**4 for x in xs)/n
    return m, sd, s, k

def psr(sr_hat, sr_bench, n, skew, kurt):
    if n < 2: return 0.0
    denom = math.sqrt(max(1e-12, 1 - skew*sr_hat + (kurt-1)/4.0*sr_hat**2))
    return norm_cdf((sr_hat - sr_bench) * math.sqrt(n-1) / denom)

GAMMA = 0.5772156649

def main():
    srs = []
    print('配置                                       n     均值%     逐笔SR    偏度     峰度')
    print('-'*86)
    for e, cfg in FILES:
        p = os.path.join(OUT, f'trades_4h_{e}_{cfg}.csv')
        if not os.path.exists(p): continue
        with open(p) as f:
            rd = list(csv.DictReader(f))
        xs = [float(r['ret']) for r in rd if r['ret']]
        if len(xs) < 30: continue
        m, sd, sk, ku = moments(xs)
        sr = m/sd if sd else 0.0
        srs.append((f'{e}|{cfg}', len(xs), m, sr, sk, ku))
        print(f'{e+"|"+cfg:<40} {len(xs):>5} {m*100:>8.3f} {sr:>9.4f} {sk:>8.3f} {ku:>8.3f}')

    N = len(srs)
    best = max(srs, key=lambda r: r[3])
    sr_vals = [r[3] for r in srs]
    V = (pstdev(sr_vals)**2) if len(sr_vals) > 1 else 0.0
    # N 次纯噪声试验中「最大 Sharpe」的期望
    sr0 = math.sqrt(V) * ((1-GAMMA)*norm_ppf(1 - 1.0/N) + GAMMA*norm_ppf(1 - 1.0/(N*math.e)))
    name, n, m, sr, sk, ku = best
    d = psr(sr, sr0, n, sk, ku)
    print('\n' + '='*86)
    print(f'试验次数 N            = {N}')
    print(f'最好配置              = {name}')
    print(f'样本数 n              = {n}')
    print(f'逐笔 Sharpe           = {sr:.4f}')
    print(f'各试验 Sharpe 方差 V  = {V:.6f}')
    print(f'零假设下最大SR期望 SR0= {sr0:.4f}  （N={N} 次试验，全部为噪声时的期望最好成绩）')
    print(f'Deflated Sharpe Ratio = {d:.4f}')
    print('='*86)
    print('判读：DSR < 0.95 → 在做过 N 次试验的前提下，该结果无法与「运气」区分。')

if __name__ == '__main__':
    main()
