import 'package:flutter/material.dart';

import 'models.dart';
import 'research_controller.dart';

const _ink = Color(0xff13231f);
const _muted = Color(0xff6d7b76);
const _line = Color(0xffdbe5df);
const _surface = Color(0xfff7faf8);
const _green = Color(0xff16845b);
const _red = Color(0xffcf524b);

class CoinDetailPage extends StatefulWidget {
  const CoinDetailPage({
    required this.symbol,
    required this.controller,
    super.key,
  });

  final String symbol;
  final ResearchController controller;

  @override
  State<CoinDetailPage> createState() => _CoinDetailPageState();
}

class _CoinDetailPageState extends State<CoinDetailPage> {
  @override
  void initState() {
    super.initState();
    // 确保选中当前币种
    WidgetsBinding.instance.addPostFrameCallback((_) {
      widget.controller.selectSymbol(widget.symbol);
      widget.controller.fetchCandles(widget.symbol);
    });
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: widget.controller,
      builder: (context, _) {
        final market = widget.controller.marketSymbols.firstWhere(
          (s) => s.code == widget.symbol,
          orElse: () => widget.controller.marketSymbols.first,
        );
        final candles = widget.controller.candles;
        final history = widget.controller.selectedHistory;
        final latestAnalysis = history.isNotEmpty ? history.first : null;

        return Scaffold(
          backgroundColor: _surface,
          appBar: AppBar(
            title: Text(market.baseCoin),
            backgroundColor: Colors.white,
            surfaceTintColor: Colors.white,
            actions: [
              IconButton(
                onPressed: widget.controller.isFetchingCandles ||
                        widget.controller.isFetchingAllKlines
                    ? null
                    : widget.controller.fetchLatestKlines,
                icon: widget.controller.isFetchingCandles ||
                        widget.controller.isFetchingAllKlines
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.download_for_offline_outlined),
                tooltip: '手动拉取全部币种 K 线',
              ),
              PopupMenuButton<String>(
                onSelected: (value) {
                  if (value == 'analyze') {
                    widget.controller.analyseCurrent();
                  }
                },
                itemBuilder: (context) => [
                  const PopupMenuItem(
                    value: 'analyze',
                    child: Row(
                      children: [
                        Icon(Icons.analytics_outlined, size: 18),
                        SizedBox(width: 8),
                        Text('分析当前币种'),
                      ],
                    ),
                  ),
                ],
              ),
            ],
          ),
          body: SingleChildScrollView(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _PriceHeader(market: market),
                const SizedBox(height: 16),
                _StatisticsCard(market: market, candles: candles),
                const SizedBox(height: 16),
                if (widget.controller.coinglassFor(widget.symbol) != null) ...[
                  _CoinglassCard(
                    data: widget.controller.coinglassFor(widget.symbol)!,
                  ),
                  const SizedBox(height: 16),
                ],
                _ChartCard(
                  controller: widget.controller,
                  candles: candles,
                  symbol: widget.symbol,
                ),
                const SizedBox(height: 16),
                if (latestAnalysis != null) ...[
                  _LatestAnalysisCard(analysis: latestAnalysis),
                  const SizedBox(height: 16),
                ],
                _AnalysisHistorySection(
                  history: history,
                  controller: widget.controller,
                ),
              ],
            ),
          ),
          floatingActionButton: FloatingActionButton.extended(
            onPressed: widget.controller.isAnalysing
                ? null
                : () => widget.controller.analyseCurrent(),
            icon: widget.controller.isAnalysing
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: Colors.white,
                    ),
                  )
                : const Icon(Icons.bolt),
            label: Text(widget.controller.isAnalysing ? '分析中...' : '分析此币种'),
          ),
        );
      },
    );
  }
}

class _PriceHeader extends StatelessWidget {
  const _PriceHeader({required this.market});
  final MarketSymbol market;

  @override
  Widget build(BuildContext context) {
    return Card(
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: const BorderSide(color: _line),
      ),
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  width: 48,
                  height: 48,
                  decoration: BoxDecoration(
                    color: _green.withValues(alpha: 0.1),
                    borderRadius: BorderRadius.circular(24),
                  ),
                  child: Center(
                    child: Text(
                      market.baseCoin.substring(0, 1),
                      style: const TextStyle(
                        fontSize: 24,
                        fontWeight: FontWeight.w800,
                        color: _green,
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        market.baseCoin,
                        style: const TextStyle(
                          fontSize: 24,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      Text(
                        market.code,
                        style: const TextStyle(
                          fontSize: 13,
                          color: _muted,
                        ),
                      ),
                    ],
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 6,
                  ),
                  decoration: BoxDecoration(
                    color: const Color(0xffeef2f0),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text(
                    'Rank ${market.rank}',
                    style: const TextStyle(
                      color: _muted,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
            const Divider(height: 24),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      '当前价格',
                      style: TextStyle(
                        fontSize: 12,
                        color: _muted,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      _formatPrice(market.price),
                      style: const TextStyle(
                        fontSize: 28,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ],
                ),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    const Text(
                      '24h 涨跌',
                      style: TextStyle(
                        fontSize: 12,
                        color: _muted,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 10,
                        vertical: 6,
                      ),
                      decoration: BoxDecoration(
                        color: market.change >= 0
                            ? _green.withValues(alpha: 0.12)
                            : _red.withValues(alpha: 0.12),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: Text(
                        '${market.change >= 0 ? '+' : ''}${market.change.toStringAsFixed(2)}%',
                        style: TextStyle(
                          color: market.change >= 0 ? _green : _red,
                          fontWeight: FontWeight.w700,
                          fontSize: 16,
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  String _formatPrice(double value) {
    if (value >= 1000) return '\$${value.toStringAsFixed(2)}';
    if (value >= 1) return '\$${value.toStringAsFixed(3)}';
    return '\$${value.toStringAsFixed(4)}';
  }
}

class _StatisticsCard extends StatelessWidget {
  const _StatisticsCard({required this.market, required this.candles});
  final MarketSymbol market;
  final List<Candle> candles;

  @override
  Widget build(BuildContext context) {
    final high = candles.isEmpty
        ? 0.0
        : candles.map((c) => c.high).reduce((a, b) => a > b ? a : b);
    final low = candles.isEmpty
        ? 0.0
        : candles.map((c) => c.low).reduce((a, b) => a < b ? a : b);
    final first = candles.isNotEmpty ? candles.first.close : market.price;
    final last = candles.isNotEmpty ? candles.last.close : market.price;
    final priceChange = ((last - first) / first * 100);

    return Card(
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: const BorderSide(color: _line),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              '统计数据',
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: _StatItem(
                    label: '市值',
                    value: market.marketCap,
                    icon: Icons.account_balance_wallet_outlined,
                  ),
                ),
                Expanded(
                  child: _StatItem(
                    label: '周期最高',
                    value: _formatPrice(high),
                    icon: Icons.arrow_upward,
                    color: _green,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: _StatItem(
                    label: '周期最低',
                    value: _formatPrice(low),
                    icon: Icons.arrow_downward,
                    color: _red,
                  ),
                ),
                Expanded(
                  child: _StatItem(
                    label: '周期涨跌',
                    value:
                        '${priceChange >= 0 ? '+' : ''}${priceChange.toStringAsFixed(2)}%',
                    icon: Icons.trending_up,
                    color: priceChange >= 0 ? _green : _red,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  String _formatPrice(double value) {
    if (value >= 1000) return '\$${value.toStringAsFixed(2)}';
    if (value >= 1) return '\$${value.toStringAsFixed(3)}';
    return '\$${value.toStringAsFixed(4)}';
  }
}

class _CoinglassCard extends StatelessWidget {
  const _CoinglassCard({required this.data});
  final CoinglassMarket data;

  @override
  Widget build(BuildContext context) {
    final lsRatio1h = data.longShortRatio1h;
    final lsLabel = lsRatio1h > 1.1
        ? '偏多'
        : lsRatio1h < 0.9
            ? '偏空'
            : '均衡';
    final lsColor = lsRatio1h > 1.1
        ? _green
        : lsRatio1h < 0.9
            ? _red
            : _muted;
    final oiChangeColor = data.openInterestChangePercent1h >= 0 ? _green : _red;
    final volChangeColor = data.volumeChangePercent1h >= 0 ? _green : _red;
    return Card(
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: const BorderSide(color: _line),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Row(
              children: [
                Icon(Icons.insights, size: 18, color: _green),
                SizedBox(width: 8),
                Text(
                  'Coinglass 市场情报',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
                ),
              ],
            ),
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: _StatItem(
                    label: '持仓量 (OI)',
                    value: '\$${data.formattedOi}',
                    icon: Icons.stacked_bar_chart,
                  ),
                ),
                Expanded(
                  child: _StatItem(
                    label: 'OI 1h 变化',
                    value:
                        '${data.openInterestChangePercent1h >= 0 ? '+' : ''}${data.openInterestChangePercent1h.toStringAsFixed(2)}%',
                    icon: Icons.trending_flat,
                    color: oiChangeColor,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: _StatItem(
                    label: '多空比 1h',
                    value: '${lsRatio1h.toStringAsFixed(2)} ($lsLabel)',
                    icon: Icons.compare_arrows,
                    color: lsColor,
                  ),
                ),
                Expanded(
                  child: _StatItem(
                    label: '交易量 1h 变化',
                    value:
                        '${data.volumeChangePercent1h >= 0 ? '+' : ''}${data.volumeChangePercent1h.toStringAsFixed(1)}%',
                    icon: Icons.bar_chart,
                    color: volChangeColor,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: _StatItem(
                    label: '1h 爆仓',
                    value: '\$${data.formattedLiquidation1h}',
                    icon: Icons.local_fire_department,
                    color: _red,
                  ),
                ),
                Expanded(
                  child: _StatItem(
                    label: '多/空爆仓 1h',
                    value:
                        '${_formatCompact(data.longLiquidationUsd1h)} / ${_formatCompact(data.shortLiquidationUsd1h)}',
                    icon: Icons.warning_amber,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: _StatItem(
                    label: '24h 价格变化',
                    value:
                        '${data.priceChangePercent24h >= 0 ? '+' : ''}${data.priceChangePercent24h.toStringAsFixed(2)}%',
                    icon: Icons.show_chart,
                    color: data.priceChangePercent24h >= 0 ? _green : _red,
                  ),
                ),
                Expanded(
                  child: _StatItem(
                    label: 'OI 24h 变化',
                    value:
                        '${data.openInterestChangePercent24h >= 0 ? '+' : ''}${data.openInterestChangePercent24h.toStringAsFixed(2)}%',
                    icon: Icons.trending_flat,
                    color:
                        data.openInterestChangePercent24h >= 0 ? _green : _red,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  String _formatCompact(double value) {
    if (value >= 1000000) return '${(value / 1000000).toStringAsFixed(1)}M';
    if (value >= 1000) return '${(value / 1000).toStringAsFixed(0)}K';
    return value.toStringAsFixed(0);
  }
}

class _StatItem extends StatelessWidget {
  const _StatItem({
    required this.label,
    required this.value,
    required this.icon,
    this.color = _ink,
  });

  final String label;
  final String value;
  final IconData icon;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          Icon(icon, size: 20, color: color),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  label,
                  style: const TextStyle(
                    fontSize: 11,
                    color: _muted,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  value,
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                    color: color,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ChartCard extends StatelessWidget {
  const _ChartCard({
    required this.controller,
    required this.candles,
    required this.symbol,
  });

  final ResearchController controller;
  final List<Candle> candles;
  final String symbol;

  @override
  Widget build(BuildContext context) {
    return Card(
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: const BorderSide(color: _line),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Text(
                  'K 线图',
                  style: TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const Spacer(),
                Text(
                  '${controller.config.interval} · ${candles.length} 根',
                  style: const TextStyle(
                    fontSize: 11,
                    color: _muted,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            SizedBox(
              height: 280,
              child: CustomPaint(
                painter: _CandlePainter(candles),
                child: const SizedBox.expand(),
              ),
            ),
            const SizedBox(height: 8),
            const Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text('历史', style: TextStyle(color: _muted, fontSize: 10)),
                Text('最新', style: TextStyle(color: _muted, fontSize: 10)),
              ],
            ),
            const SizedBox(height: 12),
            Text(
              controller.candleStatus,
              style: const TextStyle(
                fontSize: 11,
                color: _muted,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _CandlePainter extends CustomPainter {
  _CandlePainter(this.candles);
  final List<Candle> candles;

  @override
  void paint(Canvas canvas, Size size) {
    if (candles.isEmpty) return;

    final values = candles.expand((c) => [c.high, c.low]);
    final min = values.reduce((a, b) => a < b ? a : b);
    final max = values.reduce((a, b) => a > b ? a : b);
    final range = (max - min).clamp(0.0001, double.infinity).toDouble();
    final width = size.width / candles.length;

    // 绘制网格
    final grid = Paint()
      ..color = _line.withValues(alpha: 0.5)
      ..strokeWidth = 1;
    for (var i = 1; i < 5; i++) {
      final y = size.height * i / 5;
      canvas.drawLine(Offset(0, y), Offset(size.width, y), grid);
    }

    double y(double price) => size.height - (price - min) / range * size.height;

    final wickUp = Paint()
      ..color = _green
      ..strokeWidth = 1.5;
    final wickDown = Paint()
      ..color = _red
      ..strokeWidth = 1.5;

    for (var i = 0; i < candles.length; i++) {
      final candle = candles[i];
      final x = width * i + width / 2;
      final up = candle.close >= candle.open;
      final paint = up ? wickUp : wickDown;

      // 绘制影线
      canvas.drawLine(
        Offset(x, y(candle.high)),
        Offset(x, y(candle.low)),
        paint,
      );

      // 绘制实体
      final top = y(up ? candle.close : candle.open);
      final bottom = y(up ? candle.open : candle.close);
      final rect = Rect.fromLTRB(
        x - width * 0.35,
        top,
        x + width * 0.35,
        bottom.clamp(top + 1.5, size.height).toDouble(),
      );
      canvas.drawRect(rect, paint..style = PaintingStyle.fill);
    }
  }

  @override
  bool shouldRepaint(covariant _CandlePainter oldDelegate) =>
      oldDelegate.candles != candles;
}

class _LatestAnalysisCard extends StatelessWidget {
  const _LatestAnalysisCard({required this.analysis});
  final AnalysisResult analysis;

  Color get actionColor => switch (analysis.action) {
        TradeAction.openLong => _green,
        TradeAction.closeShort => _green,
        TradeAction.openShort => _red,
        TradeAction.closeLong => _red,
        TradeAction.wait => const Color(0xffbd8417),
      };

  @override
  Widget build(BuildContext context) {
    return Card(
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: const BorderSide(color: _line),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Text(
                  '最新分析',
                  style: TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const Spacer(),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 6,
                  ),
                  decoration: BoxDecoration(
                    color: actionColor.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text(
                    analysis.action.label,
                    style: TextStyle(
                      color: actionColor,
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            _AnalysisDetail(
              icon: Icons.speed,
              label: '信心度',
              value: '${analysis.confidence}%',
              color: actionColor,
            ),
            const SizedBox(height: 8),
            _AnalysisDetail(
              icon: Icons.account_balance_wallet_outlined,
              label: '仓位建议',
              value: analysis.position,
            ),
            const SizedBox(height: 8),
            _AnalysisDetail(
              icon: Icons.info_outline,
              label: '判断依据',
              value: analysis.reason,
            ),
            const SizedBox(height: 8),
            _AnalysisDetail(
              icon: Icons.warning_amber_outlined,
              label: '风险提示',
              value: analysis.risk,
              color: const Color(0xffbd8417),
            ),
            const Divider(height: 24),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: _green.withValues(alpha: 0.05),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.lightbulb_outline, size: 18, color: _green),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          '执行建议',
                          style: TextStyle(
                            fontSize: 11,
                            color: _green,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          analysis.suggestion,
                          style: const TextStyle(
                            fontSize: 12,
                            height: 1.4,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 8),
            Text(
              '生成时间: ${_formatDateTime(analysis.createdAt)}',
              style: const TextStyle(
                fontSize: 10,
                color: _muted,
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _formatDateTime(DateTime date) {
    return '${date.year}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')} '
        '${date.hour.toString().padLeft(2, '0')}:${date.minute.toString().padLeft(2, '0')}';
  }
}

class _AnalysisDetail extends StatelessWidget {
  const _AnalysisDetail({
    required this.icon,
    required this.label,
    required this.value,
    this.color = _ink,
  });

  final IconData icon;
  final String label;
  final String value;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 16, color: color),
        const SizedBox(width: 8),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                label,
                style: const TextStyle(
                  fontSize: 11,
                  color: _muted,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                value,
                style: TextStyle(
                  fontSize: 12,
                  height: 1.4,
                  color: color,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _AnalysisHistorySection extends StatelessWidget {
  const _AnalysisHistorySection({
    required this.history,
    required this.controller,
  });

  final List<AnalysisResult> history;
  final ResearchController controller;

  @override
  Widget build(BuildContext context) {
    return Card(
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: const BorderSide(color: _line),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Text(
                  '历史分析',
                  style: TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const Spacer(),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 4,
                  ),
                  decoration: BoxDecoration(
                    color: _green.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    '${history.length} 条',
                    style: const TextStyle(
                      color: _green,
                      fontSize: 11,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            if (history.isEmpty)
              const Center(
                child: Padding(
                  padding: EdgeInsets.all(24),
                  child: Column(
                    children: [
                      Icon(Icons.history, size: 40, color: _muted),
                      SizedBox(height: 8),
                      Text(
                        '暂无历史分析记录',
                        style: TextStyle(color: _muted),
                      ),
                    ],
                  ),
                ),
              )
            else
              ...history.take(5).map(
                    (item) => Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: _HistoryItem(analysis: item),
                    ),
                  ),
            if (history.length > 5)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Center(
                  child: Text(
                    '还有 ${history.length - 5} 条历史记录',
                    style: const TextStyle(
                      fontSize: 11,
                      color: _muted,
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _HistoryItem extends StatelessWidget {
  const _HistoryItem({required this.analysis});
  final AnalysisResult analysis;

  Color get actionColor => switch (analysis.action) {
        TradeAction.openLong => _green,
        TradeAction.closeShort => _green,
        TradeAction.openShort => _red,
        TradeAction.closeLong => _red,
        TradeAction.wait => const Color(0xffbd8417),
      };

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.symmetric(
              horizontal: 8,
              vertical: 4,
            ),
            decoration: BoxDecoration(
              color: actionColor.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(4),
            ),
            child: Text(
              analysis.action.label,
              style: TextStyle(
                color: actionColor,
                fontSize: 10,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          const SizedBox(width: 8),
          Text(
            '${analysis.confidence}%',
            style: TextStyle(
              color: actionColor,
              fontSize: 12,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              analysis.reason,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 11,
                color: _muted,
              ),
            ),
          ),
          Text(
            _formatTime(analysis.createdAt),
            style: const TextStyle(
              fontSize: 10,
              color: _muted,
            ),
          ),
        ],
      ),
    );
  }

  String _formatTime(DateTime date) {
    return '${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')} '
        '${date.hour.toString().padLeft(2, '0')}:${date.minute.toString().padLeft(2, '0')}';
  }
}
