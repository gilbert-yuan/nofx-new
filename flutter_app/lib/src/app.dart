import 'dart:async';

import 'package:flutter/material.dart';

import 'models.dart';
import 'research_controller.dart';
import 'coin_detail_page.dart';

const _ink = Color(0xff13231f);
const _muted = Color(0xff6d7b76);
const _line = Color(0xffdbe5df);
const _surface = Color(0xfff7faf8);
const _green = Color(0xff16845b);
const _red = Color(0xffcf524b);

class NofxApp extends StatefulWidget {
  const NofxApp({super.key});

  @override
  State<NofxApp> createState() => _NofxAppState();
}

class _NofxAppState extends State<NofxApp> {
  final controller = ResearchController();

  @override
  void initState() {
    super.initState();
    unawaited(controller.initialize());
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = ColorScheme.fromSeed(
      seedColor: _green,
      brightness: Brightness.light,
    );
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) => MaterialApp(
        debugShowCheckedModeBanner: false,
        title: 'NOFX 研究工作台',
        theme: ThemeData(
          useMaterial3: true,
          colorScheme: scheme.copyWith(surface: Colors.white, onSurface: _ink),
          scaffoldBackgroundColor: _surface,
          fontFamily: 'Microsoft YaHei',
          textTheme: const TextTheme(
            bodyMedium: TextStyle(color: _ink, fontSize: 13),
            bodySmall: TextStyle(color: _muted, fontSize: 12),
            titleLarge: TextStyle(
              color: _ink,
              fontSize: 20,
              fontWeight: FontWeight.w700,
            ),
            titleMedium: TextStyle(
              color: _ink,
              fontSize: 15,
              fontWeight: FontWeight.w700,
            ),
          ),
          inputDecorationTheme: InputDecorationTheme(
            isDense: true,
            filled: true,
            fillColor: Colors.white,
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(6),
              borderSide: const BorderSide(color: _line),
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(6),
              borderSide: const BorderSide(color: _line),
            ),
            focusedBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(6),
              borderSide: const BorderSide(color: _green, width: 1.5),
            ),
          ),
          cardTheme: CardThemeData(
            color: Colors.white,
            elevation: 0,
            margin: EdgeInsets.zero,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(8),
              side: const BorderSide(color: _line),
            ),
          ),
          dividerTheme: const DividerThemeData(
            color: _line,
            space: 1,
            thickness: 1,
          ),
        ),
        home: AppShell(controller: controller),
      ),
    );
  }
}

class AppShell extends StatefulWidget {
  const AppShell({required this.controller, super.key});

  final ResearchController controller;

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  int page = 0;

  static const labels = ['分析工作台', '当天总结', '历史分析', '策略设置'];
  static const icons = [
    Icons.analytics_outlined,
    Icons.today_outlined,
    Icons.history,
    Icons.tune_outlined,
  ];

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      onEnter: (_) {
        unawaited(widget.controller.window.setPointerHovering(true));
      },
      onExit: (_) {
        unawaited(widget.controller.window.setPointerHovering(false));
      },
      child: LayoutBuilder(
        builder: (context, constraints) {
          final wide = constraints.maxWidth >= 900;
          final content = IndexedStack(
            index: page,
            children: [
              WorkbenchPage(controller: widget.controller),
              SummaryPage(controller: widget.controller),
              HistoryPage(controller: widget.controller),
              SettingsPage(controller: widget.controller),
            ],
          );
          if (wide) {
            return Scaffold(
              body: Row(
                children: [
                  _Rail(
                    page: page,
                    onChanged: (value) => setState(() => page = value),
                  ),
                  Expanded(
                    child: Column(
                      children: [
                        _DesktopHeader(controller: widget.controller),
                        Expanded(child: content),
                      ],
                    ),
                  ),
                ],
              ),
            );
          }
          return Scaffold(
            appBar: AppBar(
              title: Text(labels[page]),
              backgroundColor: Colors.white,
              surfaceTintColor: Colors.white,
            ),
            body: content,
            bottomNavigationBar: NavigationBar(
              selectedIndex: page,
              onDestinationSelected: (value) => setState(() => page = value),
              destinations: List.generate(
                labels.length,
                (index) => NavigationDestination(
                  icon: Icon(icons[index]),
                  label: labels[index],
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

class _Rail extends StatelessWidget {
  const _Rail({required this.page, required this.onChanged});
  final int page;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 220,
      color: Colors.white,
      padding: const EdgeInsets.fromLTRB(18, 20, 12, 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Row(
            children: [
              _BrandMark(),
              SizedBox(width: 10),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'NOFX',
                    style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800),
                  ),
                  Text(
                    '合约分析工作台',
                    style: TextStyle(fontSize: 11, color: _muted),
                  ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 34),
          ...List.generate(
            _AppShellState.labels.length,
            (index) => Padding(
              padding: const EdgeInsets.only(bottom: 5),
              child: _NavItem(
                icon: _AppShellState.icons[index],
                label: _AppShellState.labels[index],
                selected: page == index,
                onTap: () => onChanged(index),
              ),
            ),
          ),
          const Spacer(),
          const Row(
            children: [
              Icon(Icons.shield_outlined, size: 16, color: _green),
              SizedBox(width: 8),
              Text(
                '研究模式 · 不执行交易',
                style: TextStyle(fontSize: 11, color: _muted),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _BrandMark extends StatelessWidget {
  const _BrandMark();
  @override
  Widget build(BuildContext context) => Container(
        width: 28,
        height: 28,
        decoration: BoxDecoration(
          color: _green,
          borderRadius: BorderRadius.circular(6),
        ),
        child: const Icon(Icons.show_chart, color: Colors.white, size: 19),
      );
}

class _NavItem extends StatelessWidget {
  const _NavItem({
    required this.icon,
    required this.label,
    required this.selected,
    required this.onTap,
  });
  final IconData icon;
  final String label;
  final bool selected;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Material(
        color: selected ? const Color(0xffe4f3eb) : Colors.transparent,
        borderRadius: BorderRadius.circular(6),
        child: InkWell(
          borderRadius: BorderRadius.circular(6),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
            child: Row(
              children: [
                Icon(icon, size: 19, color: selected ? _green : _muted),
                const SizedBox(width: 11),
                Text(
                  label,
                  style: TextStyle(
                    fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
                    color: selected ? _green : _ink,
                  ),
                ),
              ],
            ),
          ),
        ),
      );
}

class _DesktopHeader extends StatelessWidget {
  const _DesktopHeader({required this.controller});
  final ResearchController controller;

  @override
  Widget build(BuildContext context) => GestureDetector(
        onPanStart: (_) => controller.window.beginDrag(),
        child: Container(
          height: 65,
          padding: const EdgeInsets.symmetric(horizontal: 28),
          color: Colors.white,
          child: Row(
            children: [
              const Text(
                '合约市场研究',
                style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700),
              ),
              const SizedBox(width: 12),
              Text(
                controller.isOnline ? '交易所直连 · AI 直连' : 'SQLite',
                style: TextStyle(
                  color: controller.isOnline ? _green : _muted,
                  fontSize: 11,
                ),
              ),
              const Spacer(),
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                decoration: BoxDecoration(
                  color: controller.isOnline
                      ? const Color(0xffeef8f2)
                      : const Color(0xfff1f4f2),
                  borderRadius: BorderRadius.circular(5),
                ),
                child: Row(
                  children: [
                    Icon(
                      Icons.circle,
                      size: 8,
                      color: controller.isOnline ? _green : _muted,
                    ),
                    const SizedBox(width: 7),
                    Text(
                      controller.isOnline ? '交易所直连 · AI 直连' : 'SQLite',
                      style: TextStyle(
                        color: controller.isOnline ? _green : _muted,
                        fontSize: 12,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      );
}

class WorkbenchPage extends StatefulWidget {
  const WorkbenchPage({required this.controller, super.key});
  final ResearchController controller;
  @override
  State<WorkbenchPage> createState() => _WorkbenchPageState();
}

class _WorkbenchPageState extends State<WorkbenchPage> {
  final searchController = TextEditingController();
  String query = '';

  @override
  void dispose() {
    searchController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final visible = widget.controller.marketSymbols
        .where(
          (item) =>
              item.code.contains(query.toUpperCase()) ||
              item.baseCoin.contains(query.toUpperCase()),
        )
        .toList();
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _PageIntro(
            title: '分析工作台',
            subtitle:
                '交易所直连获取 K 线，Coinglass 提供持仓量与交易量情报，AI 直连完成分析；数据保存到本地 SQLite。',
            status: widget.controller.status,
          ),
          const SizedBox(height: 20),
          _ActionFeedback(controller: widget.controller),
          const SizedBox(height: 14),
          LayoutBuilder(
            builder: (context, box) {
              final compact = box.maxWidth < 1120;
              final sidebar = _SymbolPanel(
                controller: widget.controller,
                searchController: searchController,
                onSearch: (value) => setState(() => query = value),
                symbols: visible,
                onAdd: _showAddSymbolDialog,
                onFetchAll: widget.controller.fetchAllSymbols,
              );
              final main = _WorkbenchMain(controller: widget.controller);
              return compact
                  ? Column(
                      children: [sidebar, const SizedBox(height: 16), main],
                    )
                  : Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        SizedBox(width: 245, child: sidebar),
                        const SizedBox(width: 18),
                        Expanded(child: main),
                      ],
                    );
            },
          ),
        ],
      ),
    );
  }

  void _showAddSymbolDialog() {
    final input = TextEditingController();
    showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('获取新币种'),
        content: TextField(
          controller: input,
          autofocus: true,
          textCapitalization: TextCapitalization.characters,
          decoration: const InputDecoration(
            labelText: '币种代码',
            hintText: '例如 ARB 或 ARBUSDT',
            helperText: '新币种会从当前行情接口查询并加入本地 SQLite 缓存',
          ),
          onSubmitted: (_) => _submitNewSymbol(dialogContext, input),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: const Text('取消'),
          ),
          FilledButton.icon(
            onPressed: () => _submitNewSymbol(dialogContext, input),
            icon: const Icon(Icons.download_outlined, size: 17),
            label: const Text('获取币种'),
          ),
        ],
      ),
    ).then((_) => input.dispose());
  }

  Future<void> _submitNewSymbol(
    BuildContext dialogContext,
    TextEditingController input,
  ) async {
    final added = await widget.controller.addSymbol(input.text);
    if (!dialogContext.mounted) return;
    Navigator.pop(dialogContext);
    if (!added && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('请输入有效的币种代码')),
      );
    }
  }
}

class _PageIntro extends StatelessWidget {
  const _PageIntro({
    required this.title,
    required this.subtitle,
    required this.status,
  });
  final String title;
  final String subtitle;
  final String status;
  @override
  Widget build(BuildContext context) => Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: Theme.of(context).textTheme.titleLarge),
                const SizedBox(height: 5),
                Text(subtitle, style: Theme.of(context).textTheme.bodySmall),
              ],
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
            decoration: BoxDecoration(
              border: Border.all(color: _line),
              borderRadius: BorderRadius.circular(6),
            ),
            child: Row(
              children: [
                const Icon(Icons.sync, size: 15, color: _green),
                const SizedBox(width: 7),
                Text(status,
                    style: const TextStyle(fontSize: 11, color: _muted)),
              ],
            ),
          ),
        ],
      );
}

class _ActionFeedback extends StatelessWidget {
  const _ActionFeedback({required this.controller});
  final ResearchController controller;

  @override
  Widget build(BuildContext context) {
    final active = controller.isAnalysing ||
        controller.isFetchingSymbols ||
        controller.isFetchingAllKlines;
    if (!active &&
        controller.lastError == null &&
        controller.status == '等待分析') {
      return const SizedBox.shrink();
    }
    final progress = controller.isAnalysing
        ? controller.analysisProgress
        : controller.isFetchingAllKlines
            ? controller.allKlineProgress
            : controller.symbolFetchProgress;
    return Card(
      color: active ? const Color(0xfff2f8f4) : Colors.white,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  active ? Icons.sync : Icons.check_circle_outline,
                  size: 17,
                  color: active ? _green : _muted,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    controller.isFetchingAllKlines
                        ? controller.allKlineStatus
                        : controller.isFetchingSymbols
                            ? controller.symbolFetchStatus
                            : controller.status,
                    style: const TextStyle(
                        fontSize: 12, fontWeight: FontWeight.w600),
                  ),
                ),
                if (controller.isAnalysing)
                  Text(
                    '${controller.analysisCompleted}/${controller.analysisTotal}',
                    style: const TextStyle(color: _green, fontSize: 12),
                  ),
                if (controller.isFetchingSymbols)
                  Text(
                    '${controller.symbolFetchCompleted}/${controller.symbolFetchTotal}',
                    style: const TextStyle(color: _green, fontSize: 12),
                  ),
                if (controller.isFetchingAllKlines)
                  Text(
                    '${controller.allKlineCompleted}/${controller.allKlineTotal}',
                    style: const TextStyle(color: _green, fontSize: 12),
                  ),
              ],
            ),
            if (active) ...[
              const SizedBox(height: 8),
              ClipRRect(
                borderRadius: BorderRadius.circular(3),
                child: LinearProgressIndicator(
                  minHeight: 5,
                  value: progress,
                  backgroundColor: const Color(0xffdfece4),
                  color: _green,
                ),
              ),
            ],
            if (controller.lastError != null) ...[
              const SizedBox(height: 5),
              Text(controller.lastError!,
                  style: const TextStyle(color: _red, fontSize: 11)),
            ],
          ],
        ),
      ),
    );
  }
}

class _SymbolPanel extends StatelessWidget {
  const _SymbolPanel({
    required this.controller,
    required this.searchController,
    required this.onSearch,
    required this.symbols,
    required this.onAdd,
    required this.onFetchAll,
  });
  final ResearchController controller;
  final TextEditingController searchController;
  final ValueChanged<String> onSearch;
  final List<MarketSymbol> symbols;
  final VoidCallback onAdd;
  final VoidCallback onFetchAll;
  @override
  Widget build(BuildContext context) => Card(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 12, 8, 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Expanded(
                        child: Text('市场标的',
                            style: TextStyle(fontWeight: FontWeight.w700)),
                      ),
                      IconButton(
                        onPressed: controller.isFetchingSymbols ||
                                controller.isFetchingAllKlines ||
                                controller.isAnalysing
                            ? null
                            : onAdd,
                        tooltip: '获取新币种',
                        visualDensity: VisualDensity.compact,
                        icon: const Icon(Icons.add_circle_outline, size: 19),
                      ),
                      IconButton(
                        onPressed: controller.isFetchingSymbols ||
                                controller.isFetchingAllKlines ||
                                controller.isAnalysing
                            ? null
                            : onFetchAll,
                        tooltip: '获取全部币种',
                        visualDensity: VisualDensity.compact,
                        icon: controller.isFetchingSymbols
                            ? const SizedBox(
                                width: 16,
                                height: 16,
                                child:
                                    CircularProgressIndicator(strokeWidth: 2),
                              )
                            : const Icon(Icons.download_for_offline_outlined,
                                size: 19),
                      ),
                    ],
                  ),
                  const Text(
                    '点击右侧箭头查看详情',
                    style: TextStyle(fontSize: 10, color: _muted),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: TextField(
                controller: searchController,
                onChanged: onSearch,
                decoration: const InputDecoration(
                  hintText: '搜索 BTC / ETH',
                  prefixIcon: Icon(Icons.search, size: 18),
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 10, 12, 2),
              child: SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  onPressed: controller.isFetchingSymbols ||
                          controller.isFetchingAllKlines ||
                          controller.isAnalysing
                      ? null
                      : onFetchAll,
                  icon: const Icon(Icons.download_outlined, size: 16),
                  label: Text(
                    controller.isFetchingAllKlines
                        ? '正在拉取全部币种 K 线...'
                        : controller.isFetchingSymbols
                            ? '正在获取全部币种...'
                            : '获取全部币种',
                  ),
                ),
              ),
            ),
            const SizedBox(height: 8),
            SizedBox(
              height: 488,
              child: ListView.builder(
                itemCount: symbols.length,
                itemBuilder: (context, index) => _SymbolTile(
                  symbol: symbols[index],
                  selected: symbols[index].code == controller.selectedSymbol,
                  controller: controller,
                  onTap: () {
                    controller.selectSymbol(symbols[index].code);
                    controller.fetchCandles(symbols[index].code);
                  },
                ),
              ),
            ),
          ],
        ),
      );
}

class _SymbolTile extends StatelessWidget {
  const _SymbolTile({
    required this.symbol,
    required this.selected,
    required this.controller,
    required this.onTap,
  });
  final MarketSymbol symbol;
  final bool selected;
  final ResearchController controller;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Card(
        margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
        elevation: selected ? 2 : 0,
        color: selected ? const Color(0xffeaf6ef) : Colors.white,
        child: InkWell(
          onTap: () {
            // 整张卡片点击直接进入详情页
            Navigator.of(context).push(
              MaterialPageRoute(
                builder: (context) => CoinDetailPage(
                  symbol: symbol.code,
                  controller: controller,
                ),
              ),
            );
          },
          borderRadius: BorderRadius.circular(8),
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Row(
              children: [
                // 币种图标
                Container(
                  width: 44,
                  height: 44,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: selected ? _green : const Color(0xffedf2ef),
                    borderRadius: BorderRadius.circular(22),
                  ),
                  child: Text(
                    symbol.baseCoin.substring(0, 1),
                    style: TextStyle(
                      fontSize: 18,
                      color: selected ? Colors.white : _green,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                // 币种信息
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Text(
                            symbol.baseCoin,
                            style: const TextStyle(
                              fontWeight: FontWeight.w700,
                              fontSize: 15,
                            ),
                          ),
                          const SizedBox(width: 6),
                          Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 6,
                              vertical: 2,
                            ),
                            decoration: BoxDecoration(
                              color: const Color(0xffeef2f0),
                              borderRadius: BorderRadius.circular(3),
                            ),
                            child: Text(
                              '#${symbol.rank}',
                              style: const TextStyle(
                                fontSize: 9,
                                color: _muted,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 2),
                      Text(
                        _formatPrice(symbol.price),
                        style: const TextStyle(
                          fontSize: 13,
                          color: _muted,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ],
                  ),
                ),
                // 涨跌幅和箭头
                Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 4,
                      ),
                      decoration: BoxDecoration(
                        color: symbol.change >= 0
                            ? _green.withValues(alpha: 0.12)
                            : _red.withValues(alpha: 0.12),
                        borderRadius: BorderRadius.circular(4),
                      ),
                      child: Text(
                        '${symbol.change >= 0 ? '+' : ''}${symbol.change.toStringAsFixed(2)}%',
                        style: TextStyle(
                          fontSize: 12,
                          color: symbol.change >= 0 ? _green : _red,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                    const SizedBox(height: 4),
                    Icon(
                      Icons.arrow_forward_ios,
                      size: 12,
                      color: _muted.withValues(alpha: 0.5),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      );

  String _formatPrice(double value) {
    if (value >= 1000) return '\$${value.toStringAsFixed(0)}';
    if (value >= 1) return '\$${value.toStringAsFixed(2)}';
    if (value >= 0.01) return '\$${value.toStringAsFixed(3)}';
    return '\$${value.toStringAsExponential(2)}';
  }
}

class _WorkbenchMain extends StatelessWidget {
  const _WorkbenchMain({required this.controller});
  final ResearchController controller;
  @override
  Widget build(BuildContext context) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SelectedMarket(controller: controller),
          const SizedBox(height: 14),
          _ScopeCard(controller: controller),
          const SizedBox(height: 14),
          _ChartCard(controller: controller),
          const SizedBox(height: 14),
          _ResultSection(controller: controller),
        ],
      );
}

class _SelectedMarket extends StatelessWidget {
  const _SelectedMarket({required this.controller});
  final ResearchController controller;
  @override
  Widget build(BuildContext context) {
    final market = controller.selectedMarket;
    return Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Text(
                    market.baseCoin,
                    style: const TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    market.code,
                    style: const TextStyle(color: _muted, fontSize: 12),
                  ),
                  const SizedBox(width: 10),
                  _Pill(
                    text: 'Rank ${market.rank}',
                    color: const Color(0xffeef2f0),
                    foreground: _muted,
                  ),
                ],
              ),
              const SizedBox(height: 7),
              Row(
                children: [
                  Text(
                    _price(market.price),
                    style: const TextStyle(
                      fontSize: 24,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Text(
                    '${market.change >= 0 ? '+' : ''}${market.change.toStringAsFixed(2)}%',
                    style: TextStyle(
                      color: market.change >= 0 ? _green : _red,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
        Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Text(
              controller.coinglassFor(market.code) != null
                  ? 'OI \$${controller.coinglassFor(market.code)!.formattedOi}'
                  : '市值 ${market.marketCap}',
              style: const TextStyle(color: _muted, fontSize: 12),
            ),
            const SizedBox(height: 4),
            Text(
              controller.coinglassFor(market.code) != null
                  ? 'Coinglass'
                  : controller.isOnline
                      ? '交易所行情'
                      : 'SQLite',
              style: TextStyle(
                color: controller.coinglassFor(market.code) != null
                    ? const Color(0xff6366f1)
                    : _green,
                fontSize: 11,
              ),
            ),
          ],
        ),
      ],
    );
  }
}

class _ScopeCard extends StatelessWidget {
  const _ScopeCard({required this.controller});
  final ResearchController controller;
  @override
  Widget build(BuildContext context) {
    final config = controller.config;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('分析范围', style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 12),
            Wrap(
              spacing: 12,
              runSpacing: 12,
              children: [
                _SelectField(
                  label: '周期',
                  value: config.interval,
                  values: const ['4h', '1h', '1d'],
                  onChanged: (value) =>
                      controller.updateConfig(config.copyWith(interval: value)),
                ),
                _NumberField(
                  label: 'K 线数量',
                  value: config.klineCount,
                  min: 20,
                  max: 200,
                  onChanged: (value) => controller.updateConfig(
                    config.copyWith(klineCount: value),
                  ),
                  width: 115,
                ),
                _NumberField(
                  label: '最大标的',
                  value: config.maxSymbols,
                  min: 1,
                  max: 300,
                  onChanged: (value) => controller.updateConfig(
                    config.copyWith(maxSymbols: value),
                  ),
                  width: 115,
                ),
                _NumberField(
                  label: '批量大小',
                  value: config.batchSize,
                  min: 1,
                  max: 20,
                  onChanged: (value) => controller.updateConfig(
                    config.copyWith(batchSize: value),
                  ),
                  width: 115,
                ),
                _NumberField(
                  label: '刷新间隔（秒）',
                  value: controller.refreshSeconds,
                  min: 15,
                  max: 3600,
                  onChanged: controller.setRefreshSeconds,
                  width: 140,
                ),
              ],
            ),
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
              color: const Color(0xfff4f8f5),
              child: Row(
                children: [
                  const Icon(Icons.autorenew, size: 17, color: _green),
                  const SizedBox(width: 8),
                  const Expanded(
                    child: Text(
                      '单币盯盘自动刷新 K 线，不会自动下单或执行交易。',
                      style: TextStyle(fontSize: 12),
                    ),
                  ),
                  Switch.adaptive(
                    value: controller.autoRefresh,
                    onChanged: controller.setAutoRefresh,
                  ),
                ],
              ),
            ),
            if (controller.isAnalysing || controller.lastError != null) ...[
              const SizedBox(height: 14),
              _AnalysisProgress(controller: controller),
            ],
            const SizedBox(height: 12),
            TextFormField(
              initialValue: config.customSymbols,
              decoration: const InputDecoration(
                labelText: '自定义标的（可选，用逗号分隔）',
                hintText: 'BTCUSDT, ETHUSDT',
              ),
              onChanged: (value) => controller.updateConfig(
                config.copyWith(customSymbols: value),
              ),
            ),
            const SizedBox(height: 14),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                FilledButton.icon(
                  onPressed: controller.isAnalysing ||
                          controller.isFetchingSymbols ||
                          controller.isFetchingAllKlines
                      ? null
                      : controller.analyseCurrent,
                  icon: const Icon(Icons.bolt, size: 17),
                  label: const Text('分析当前'),
                ),
                OutlinedButton.icon(
                  onPressed: controller.isAnalysing ||
                          controller.isFetchingSymbols ||
                          controller.isFetchingAllKlines
                      ? null
                      : controller.analyseRange,
                  icon: const Icon(Icons.playlist_play, size: 17),
                  label: const Text('分析范围'),
                ),
                OutlinedButton.icon(
                  onPressed: controller.isAnalysing ||
                          controller.isFetchingSymbols ||
                          controller.isFetchingAllKlines
                      ? null
                      : controller.analyseMarket,
                  icon: const Icon(Icons.public, size: 17),
                  label: Text('分析市场 (${config.maxSymbols})'),
                ),
                FilledButton.tonalIcon(
                  onPressed: controller.isAnalysing ||
                          controller.isFetchingSymbols ||
                          controller.isFetchingAllKlines
                      ? null
                      : controller.analyseAll,
                  icon: const Icon(Icons.analytics, size: 17),
                  label: Text('分析全部 (${controller.marketSymbols.length})'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _SelectField extends StatelessWidget {
  const _SelectField({
    required this.label,
    required this.value,
    required this.values,
    required this.onChanged,
  });
  final String label;
  final String value;
  final List<String> values;
  final ValueChanged<String> onChanged;
  @override
  Widget build(BuildContext context) => SizedBox(
        width: 115,
        child: DropdownButtonFormField<String>(
          initialValue: value,
          decoration: InputDecoration(labelText: label),
          items: values
              .map((item) => DropdownMenuItem(value: item, child: Text(item)))
              .toList(),
          onChanged: (item) {
            if (item != null) onChanged(item);
          },
        ),
      );
}

class _NumberField extends StatefulWidget {
  const _NumberField({
    required this.label,
    required this.value,
    required this.min,
    required this.max,
    required this.onChanged,
    required this.width,
  });
  final String label;
  final int value;
  final int min;
  final int max;
  final ValueChanged<int> onChanged;
  final double width;
  @override
  State<_NumberField> createState() => _NumberFieldState();
}

class _NumberFieldState extends State<_NumberField> {
  late final TextEditingController input = TextEditingController(
    text: '${widget.value}',
  );
  @override
  void dispose() {
    input.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => SizedBox(
        width: widget.width,
        child: TextFormField(
          controller: input,
          keyboardType: TextInputType.number,
          decoration: InputDecoration(labelText: widget.label),
          onFieldSubmitted: (value) {
            final number = int.tryParse(
              value,
            )?.clamp(widget.min, widget.max).toInt();
            if (number != null) {
              input.text = '$number';
              widget.onChanged(number);
            }
          },
        ),
      );
}

class _ChartCard extends StatelessWidget {
  const _ChartCard({required this.controller});
  final ResearchController controller;
  @override
  Widget build(BuildContext context) {
    final candles = controller.candles;
    return Card(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 14, 14, 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Text(
                  'K 线图',
                  style: TextStyle(fontWeight: FontWeight.w700),
                ),
                const Spacer(),
                Flexible(
                  child: Text(
                    controller.candleStatus,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    textAlign: TextAlign.right,
                    style: const TextStyle(fontSize: 11, color: _muted),
                  ),
                ),
                const SizedBox(width: 4),
                IconButton(
                  onPressed: controller.isFetchingCandles ||
                          controller.isFetchingAllKlines
                      ? null
                      : () => controller.fetchCandles(),
                  tooltip: '刷新当前币种 K 线',
                  visualDensity: VisualDensity.compact,
                  icon: controller.isFetchingCandles ||
                          controller.isFetchingAllKlines
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.refresh, size: 18),
                ),
                TextButton.icon(
                  onPressed: controller.isFetchingCandles ||
                          controller.isFetchingAllKlines ||
                          controller.isAnalysing
                      ? null
                      : controller.fetchLatestKlines,
                  icon: const Icon(Icons.download_outlined, size: 15),
                  label: const Text('手动拉取全部币种 K 线'),
                ),
              ],
            ),
            const SizedBox(height: 8),
            SizedBox(
              height: 240,
              child: CustomPaint(
                painter: CandlePainter(candles),
                child: const SizedBox.expand(),
              ),
            ),
            const SizedBox(height: 4),
            const Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text('历史', style: TextStyle(color: _muted, fontSize: 10)),
                Text('最新', style: TextStyle(color: _muted, fontSize: 10)),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _AnalysisProgress extends StatelessWidget {
  const _AnalysisProgress({required this.controller});
  final ResearchController controller;

  @override
  Widget build(BuildContext context) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  controller.status,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 12, color: _muted),
                ),
              ),
              if (controller.isAnalysing)
                Text(
                  '${controller.analysisCompleted}/${controller.analysisTotal}',
                  style: const TextStyle(
                    fontSize: 12,
                    color: _green,
                    fontWeight: FontWeight.w700,
                  ),
                ),
            ],
          ),
          const SizedBox(height: 7),
          ClipRRect(
            borderRadius: BorderRadius.circular(3),
            child: LinearProgressIndicator(
              minHeight: 5,
              value:
                  controller.isAnalysing ? controller.analysisProgress : null,
              backgroundColor: const Color(0xffe8efeb),
              color: _green,
            ),
          ),
          if (controller.lastError != null) ...[
            const SizedBox(height: 6),
            Text(
              controller.lastError!,
              style: const TextStyle(color: Color(0xffa56c17), fontSize: 11),
            ),
          ],
        ],
      );
}

class CandlePainter extends CustomPainter {
  CandlePainter(this.candles);
  final List<Candle> candles;
  @override
  void paint(Canvas canvas, Size size) {
    if (candles.isEmpty) return;
    final values = candles.expand((c) => [c.high, c.low]);
    final min = values.reduce((a, b) => a < b ? a : b);
    final max = values.reduce((a, b) => a > b ? a : b);
    final range = (max - min).clamp(0.0001, double.infinity).toDouble();
    final width = size.width / candles.length;
    final grid = Paint()
      ..color = _line.withValues(alpha: 0.5)
      ..strokeWidth = 1;
    for (var i = 1; i < 4; i++) {
      final y = size.height * i / 4;
      canvas.drawLine(Offset(0, y), Offset(size.width, y), grid);
    }
    double y(double price) => size.height - (price - min) / range * size.height;
    final wickUp = Paint()
      ..color = _green
      ..strokeWidth = 1.2;
    final wickDown = Paint()
      ..color = _red
      ..strokeWidth = 1.2;
    for (var i = 0; i < candles.length; i++) {
      final candle = candles[i];
      final x = width * i + width / 2;
      final up = candle.close >= candle.open;
      final paint = up ? wickUp : wickDown;
      canvas.drawLine(
        Offset(x, y(candle.high)),
        Offset(x, y(candle.low)),
        paint,
      );
      final top = y(up ? candle.close : candle.open);
      final bottom = y(up ? candle.open : candle.close);
      final rect = Rect.fromLTRB(
        x - width * .32,
        top,
        x + width * .32,
        bottom.clamp(top + 1.5, size.height).toDouble(),
      );
      canvas.drawRect(rect, paint..style = PaintingStyle.fill);
    }
  }

  @override
  bool shouldRepaint(covariant CandlePainter oldDelegate) =>
      oldDelegate.candles != candles;
}

class _ResultSection extends StatelessWidget {
  const _ResultSection({required this.controller});
  final ResearchController controller;
  @override
  Widget build(BuildContext context) {
    final items = controller.selectedHistory
        .where(
          (item) =>
              !controller.showOnlyActionable || item.action != TradeAction.wait,
        )
        .toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text(
              '${controller.selectedMarket.baseCoin} 历史分析',
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
            const SizedBox(width: 8),
            _Pill(
              text: '${items.length} 条',
              color: const Color(0xffeaf6ef),
              foreground: _green,
            ),
          ],
        ),
        const SizedBox(height: 10),
        if (items.isEmpty)
          const _EmptyState(text: '该币种暂无历史分析结果')
        else
          ...items.map(
            (item) => Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: _ResultCard(result: item, controller: controller),
            ),
          ),
      ],
    );
  }
}

class _ResultCard extends StatelessWidget {
  const _ResultCard({required this.result, this.controller});
  final AnalysisResult result;
  final ResearchController? controller;
  Color get color => switch (result.action) {
        TradeAction.openLong => _green,
        TradeAction.closeShort => _green,
        TradeAction.openShort => _red,
        TradeAction.closeLong => _red,
        TradeAction.wait => const Color(0xffbd8417),
      };
  @override
  Widget build(BuildContext context) => Card(
        child: InkWell(
          onTap: controller != null
              ? () {
                  Navigator.of(context).push(
                    MaterialPageRoute(
                      builder: (context) => CoinDetailPage(
                        symbol: result.symbol,
                        controller: controller!,
                      ),
                    ),
                  );
                }
              : null,
          borderRadius: BorderRadius.circular(8),
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Text(
                      result.symbol,
                      style: const TextStyle(fontWeight: FontWeight.w800),
                    ),
                    const SizedBox(width: 8),
                    _Pill(
                      text: result.action.label,
                      color: color.withValues(alpha: .12),
                      foreground: color,
                    ),
                    const Spacer(),
                    Text(
                      '信心 ${result.confidence}%',
                      style: TextStyle(
                        color: color,
                        fontWeight: FontWeight.w700,
                        fontSize: 12,
                      ),
                    ),
                    if (controller != null) ...[
                      const SizedBox(width: 8),
                      const Icon(Icons.arrow_forward_ios,
                          size: 14, color: _muted),
                    ],
                  ],
                ),
                const SizedBox(height: 12),
                Wrap(
                  spacing: 24,
                  runSpacing: 8,
                  children: [
                    _Metric(label: '仓位建议', value: result.position),
                    _Metric(label: '判断依据', value: result.reason),
                    _Metric(label: '风险提示', value: result.risk),
                  ],
                ),
                const SizedBox(height: 10),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(9),
                  color: const Color(0xfff4f8f5),
                  child: Text(
                    '建议  ${result.suggestion}',
                    style: const TextStyle(fontSize: 12, color: _ink),
                  ),
                ),
              ],
            ),
          ),
        ),
      );
}

class _Metric extends StatelessWidget {
  const _Metric({required this.label, required this.value});
  final String label;
  final String value;
  @override
  Widget build(BuildContext context) => SizedBox(
        width: 190,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: const TextStyle(color: _muted, fontSize: 11)),
            const SizedBox(height: 3),
            Text(value, style: const TextStyle(fontSize: 12, height: 1.35)),
          ],
        ),
      );
}

class SummaryPage extends StatefulWidget {
  const SummaryPage({required this.controller, super.key});
  final ResearchController controller;

  @override
  State<SummaryPage> createState() => _SummaryPageState();
}

class _SummaryPageState extends State<SummaryPage> {
  TradeAction? filter;

  @override
  Widget build(BuildContext context) {
    final all = widget.controller.results;
    final visible = filter == null
        ? all
        : all.where((item) => item.action == filter).toList();
    final actionable =
        all.where((item) => item.action != TradeAction.wait).length;
    final longs =
        all.where((item) => item.action == TradeAction.openLong).length;
    final shorts =
        all.where((item) => item.action == TradeAction.openShort).length;
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _PageIntro(
            title: '当天总结',
            subtitle: '聚合本地 SQLite 保存的最近一次 AI 市场判断。',
            status: '${all.length} 个最新结果',
          ),
          const SizedBox(height: 20),
          Wrap(
            spacing: 12,
            runSpacing: 12,
            children: [
              _SummaryTile(
                label: '已分析标的',
                value: '${all.length}',
                icon: Icons.query_stats,
                color: _green,
              ),
              _SummaryTile(
                label: '可执行信号',
                value: '$actionable',
                icon: Icons.bolt,
                color: const Color(0xffbd8417),
              ),
              _SummaryTile(
                label: '做多倾向',
                value: '$longs',
                icon: Icons.trending_up,
                color: _green,
              ),
              _SummaryTile(
                label: '做空倾向',
                value: '$shorts',
                icon: Icons.trending_down,
                color: _red,
              ),
            ],
          ),
          const SizedBox(height: 24),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              ChoiceChip(
                label: const Text('全部'),
                selected: filter == null,
                onSelected: (_) => setState(() => filter = null),
              ),
              ...TradeAction.values.map(
                (action) => ChoiceChip(
                  label: Text(
                    '${action.label} ${all.where((item) => item.action == action).length}',
                  ),
                  selected: filter == action,
                  onSelected: (_) => setState(() => filter = action),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          if (visible.isEmpty)
            const _EmptyState(text: '没有符合条件的分析结果')
          else
            ...visible.map(
              (item) => Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: _ResultCard(result: item, controller: widget.controller),
              ),
            ),
        ],
      ),
    );
  }
}

class _SummaryTile extends StatelessWidget {
  const _SummaryTile({
    required this.label,
    required this.value,
    required this.icon,
    required this.color,
  });
  final String label;
  final String value;
  final IconData icon;
  final Color color;
  @override
  Widget build(BuildContext context) => SizedBox(
        width: 180,
        child: Card(
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Row(
              children: [
                Icon(icon, color: color, size: 22),
                const SizedBox(width: 12),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      value,
                      style: const TextStyle(
                        fontSize: 22,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    Text(
                      label,
                      style: const TextStyle(fontSize: 11, color: _muted),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      );
}

class HistoryPage extends StatefulWidget {
  const HistoryPage({required this.controller, super.key});
  final ResearchController controller;
  @override
  State<HistoryPage> createState() => _HistoryPageState();
}

class _HistoryPageState extends State<HistoryPage> {
  TradeAction? filter;
  @override
  Widget build(BuildContext context) {
    var items = widget.controller.history;
    if (filter != null) {
      items = items.where((item) => item.action == filter).toList();
    }
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _PageIntro(
            title: '历史分析',
            subtitle: '查看持久化到本地 SQLite 的分析记录与完整判断依据。',
            status: '${widget.controller.history.length} 条记录',
          ),
          const SizedBox(height: 20),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  ChoiceChip(
                    label: const Text('全部'),
                    selected: filter == null,
                    onSelected: (_) => setState(() => filter = null),
                  ),
                  ...TradeAction.values.map(
                    (action) => ChoiceChip(
                      label: Text(action.label),
                      selected: filter == action,
                      onSelected: (_) => setState(() => filter = action),
                    ),
                  ),
                  const SizedBox(width: 12),
                  OutlinedButton.icon(
                    onPressed: widget.controller.history.isEmpty
                        ? null
                        : () => _confirmClear(context),
                    icon: const Icon(Icons.delete_outline, size: 17),
                    label: const Text('清空记录'),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 14),
          if (items.isEmpty)
            const _EmptyState(text: '没有符合条件的记录')
          else
            ...items.map(
              (item) => Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: _HistoryRow(
                  item: item,
                  onTap: () => _showDetail(context, item),
                ),
              ),
            ),
        ],
      ),
    );
  }

  void _confirmClear(BuildContext context) {
    showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('清空历史记录？'),
        content: const Text('本地 SQLite 中的分析历史将被移除。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () {
              widget.controller.clearHistory();
              Navigator.pop(context);
            },
            child: const Text('清空'),
          ),
        ],
      ),
    );
  }

  void _showDetail(BuildContext context, AnalysisResult item) {
    showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: Row(
          children: [
            Text(item.symbol),
            const SizedBox(width: 8),
            _Pill(
              text: item.action.label,
              color: _green.withValues(alpha: .12),
              foreground: _green,
            ),
          ],
        ),
        content: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '生成时间  ${_formatDate(item.createdAt)}',
                style: const TextStyle(color: _muted, fontSize: 12),
              ),
              const SizedBox(height: 16),
              _Detail(label: '仓位建议', value: item.position),
              _Detail(label: '判断依据', value: item.reason),
              _Detail(label: '风险提示', value: item.risk),
              _Detail(label: '执行建议', value: item.suggestion),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('关闭'),
          ),
        ],
      ),
    );
  }
}

class _HistoryRow extends StatelessWidget {
  const _HistoryRow({required this.item, required this.onTap});
  final AnalysisResult item;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Card(
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(8),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            child: Row(
              children: [
                SizedBox(
                  width: 85,
                  child: Text(
                    item.symbol,
                    style: const TextStyle(fontWeight: FontWeight.w700),
                  ),
                ),
                _Pill(
                  text: item.action.label,
                  color: _green.withValues(alpha: .12),
                  foreground: _green,
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Text(
                    item.reason,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(color: _muted, fontSize: 12),
                  ),
                ),
                Text(
                  _formatDate(item.createdAt),
                  style: const TextStyle(color: _muted, fontSize: 11),
                ),
                const SizedBox(width: 8),
                const Icon(Icons.chevron_right, size: 18, color: _muted),
              ],
            ),
          ),
        ),
      );
}

class SettingsPage extends StatelessWidget {
  const SettingsPage({required this.controller, super.key});
  final ResearchController controller;
  @override
  Widget build(BuildContext context) => SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _PageIntro(
              title: '策略设置',
              subtitle: '配置交易所行情直连、Coinglass 市场情报、AI 直连、分析策略、本地 SQLite 和窗口行为。',
              status: controller.isOnline ? '交易所直连 · AI 直连' : 'SQLite',
            ),
            const SizedBox(height: 20),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'AI 模型配置',
                      style:
                          TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
                    ),
                    const SizedBox(height: 16),
                    Row(
                      children: [
                        const Expanded(
                          child: Text(
                            '启用 AI 分析\nAI 直连；分析结果会保存到本地 SQLite，研究模式不执行交易',
                            style: TextStyle(height: 1.5),
                          ),
                        ),
                        Switch(
                          value: controller.aiEnabled,
                          onChanged: controller.setAiEnabled,
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      initialValue: controller.marketApiBaseUrl,
                      onChanged: controller.setMarketApiBaseUrl,
                      keyboardType: TextInputType.url,
                      decoration: const InputDecoration(
                        labelText: '交易所行情地址',
                        hintText: 'https://api.bybit.com',
                        prefixIcon: Icon(Icons.show_chart_outlined),
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      initialValue: controller.aiApiBaseUrl,
                      onChanged: controller.setAiApiBaseUrl,
                      keyboardType: TextInputType.url,
                      decoration: const InputDecoration(
                        labelText: 'AI API 地址',
                        hintText: 'https://api.openai.com/v1',
                        prefixIcon: Icon(Icons.link_outlined),
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      initialValue: controller.apiKey,
                      onChanged: controller.setApiKey,
                      obscureText: true,
                      decoration: const InputDecoration(
                        labelText: 'AI API Key',
                        prefixIcon: Icon(Icons.key_outlined),
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      initialValue: controller.strategyName,
                      onChanged: controller.setStrategyName,
                      decoration: const InputDecoration(
                        labelText: '策略名称',
                        prefixIcon: Icon(Icons.auto_graph_outlined),
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      initialValue: controller.modelName,
                      onChanged: controller.setModelName,
                      decoration: const InputDecoration(
                        labelText: '模型名称',
                        prefixIcon: Icon(Icons.memory_outlined),
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      initialValue: controller.systemPrompt,
                      onChanged: controller.setSystemPrompt,
                      maxLines: 3,
                      decoration: const InputDecoration(labelText: '系统提示词'),
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      initialValue: controller.analysisRules,
                      onChanged: controller.setAnalysisRules,
                      maxLines: 4,
                      decoration: const InputDecoration(labelText: '分析规则'),
                    ),
                    const SizedBox(height: 18),
                    Row(
                      children: [
                        const Expanded(
                          child: Text(
                            '保守仓位模式\n降低信号的建议仓位范围',
                            style: TextStyle(height: 1.5),
                          ),
                        ),
                        Switch(
                          value: controller.conservativeMode,
                          onChanged: controller.setConservativeMode,
                        ),
                      ],
                    ),
                    const Divider(height: 24),
                    Row(
                      children: [
                        const Expanded(
                          child:
                              Text('只显示可执行信号', style: TextStyle(height: 1.5)),
                        ),
                        Switch(
                          value: controller.showOnlyActionable,
                          onChanged: controller.setShowOnlyActionable,
                        ),
                      ],
                    ),
                    const Divider(height: 24),
                    Text(
                      '风险阈值  ${(controller.riskThreshold * 100).round()}%',
                      style: const TextStyle(fontWeight: FontWeight.w600),
                    ),
                    Slider(
                      value: controller.riskThreshold,
                      min: .3,
                      max: .9,
                      divisions: 12,
                      label: '${(controller.riskThreshold * 100).round()}%',
                      onChanged: controller.setRiskThreshold,
                    ),
                    const SizedBox(height: 8),
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            controller.settingsStatus,
                            style: const TextStyle(color: _muted, fontSize: 11),
                          ),
                        ),
                        FilledButton.icon(
                          onPressed: controller.saveAiSettings,
                          icon: const Icon(Icons.save_outlined, size: 16),
                          label: const Text('保存 AI 配置'),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 14),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'Coinglass 行情',
                      style:
                          TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      '获取合约持仓量、交易量变化、多空比、爆仓数据，注入 AI 分析上下文以提升判断质量。',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                    const SizedBox(height: 16),
                    Row(
                      children: [
                        const Expanded(
                          child: Text(
                            '启用 Coinglass\n持仓量、多空比、爆仓数据注入 AI 分析',
                            style: TextStyle(height: 1.5),
                          ),
                        ),
                        Switch(
                          value: controller.coinglassEnabled,
                          onChanged: controller.setCoinglassEnabled,
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      initialValue: controller.coinglassApiBaseUrl,
                      onChanged: controller.setCoinglassApiBaseUrl,
                      keyboardType: TextInputType.url,
                      decoration: const InputDecoration(
                        labelText: 'Coinglass API 地址',
                        hintText: 'https://open-api-v4.coinglass.com',
                        prefixIcon: Icon(Icons.cloud_outlined),
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      initialValue: controller.coinglassApiKey,
                      onChanged: controller.setCoinglassApiKey,
                      obscureText: true,
                      decoration: const InputDecoration(
                        labelText: 'Coinglass API Key',
                        hintText: 'CG-API-KEY',
                        prefixIcon: Icon(Icons.vpn_key_outlined),
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      controller.coinglassStatus,
                      style: const TextStyle(color: _muted, fontSize: 11),
                    ),
                    const SizedBox(height: 8),
                    Align(
                      alignment: Alignment.centerRight,
                      child: TextButton.icon(
                        onPressed: controller.coinglassEnabled
                            ? () => controller.fetchCoinglassMarkets()
                            : null,
                        icon: const Icon(Icons.refresh, size: 16),
                        label: const Text('刷新行情'),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 14),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'Windows 窗口',
                      style:
                          TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
                    ),
                    const SizedBox(height: 10),
                    Text(
                      controller.window.isSupported
                          ? '支持置顶、悬浮小窗、无边框拖动，以及鼠标移出窗口或失焦时自动降低透明度。'
                          : '当前平台不提供 Windows 窗口控制，应用仍可正常使用。',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                    const SizedBox(height: 10),
                    SwitchListTile.adaptive(
                      contentPadding: EdgeInsets.zero,
                      title: const Text('窗口置顶'),
                      subtitle: const Text('保持盯盘窗口显示在其他窗口上方'),
                      value: controller.windowAlwaysOnTop,
                      onChanged: controller.window.isSupported
                          ? controller.setWindowAlwaysOnTop
                          : null,
                    ),
                    SwitchListTile.adaptive(
                      contentPadding: EdgeInsets.zero,
                      title: const Text('悬浮小窗'),
                      subtitle: const Text('切换到 420 × 620 的紧凑窗口尺寸'),
                      value: controller.windowCompact,
                      onChanged: controller.window.isSupported
                          ? controller.setWindowCompact
                          : null,
                    ),
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        const Text('窗口透明度',
                            style: TextStyle(fontWeight: FontWeight.w600)),
                        const SizedBox(width: 12),
                        Text('${(controller.windowOpacity * 100).round()}%',
                            style: const TextStyle(color: _muted)),
                      ],
                    ),
                    Slider(
                      value: controller.windowOpacity,
                      min: .3,
                      max: 1,
                      divisions: 14,
                      label: '${(controller.windowOpacity * 100).round()}%',
                      onChanged: controller.window.isSupported
                          ? controller.setWindowOpacity
                          : null,
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 14),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      '运行说明',
                      style:
                          TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
                    ),
                    const SizedBox(height: 10),
                    Text(
                      '应用直连交易所获取合约目录与 K 线，通过 Coinglass 获取持仓量、交易量、多空比和爆仓数据，直连 AI API 执行分析；数据保存到本地 SQLite。应用只做研究展示，不执行真实交易。',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                    const SizedBox(height: 12),
                    const Row(
                      children: [
                        Icon(Icons.check_circle_outline,
                            size: 17, color: _green),
                        SizedBox(width: 8),
                        Text(
                          '交易所直连 · Coinglass 情报 · AI 直连 · SQLite',
                          style: TextStyle(
                            color: _green,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      );
}

class _Detail extends StatelessWidget {
  const _Detail({required this.label, required this.value});
  final String label;
  final String value;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: const TextStyle(color: _muted, fontSize: 11)),
            const SizedBox(height: 3),
            Text(value, style: const TextStyle(height: 1.4)),
          ],
        ),
      );
}

class _Pill extends StatelessWidget {
  const _Pill({
    required this.text,
    required this.color,
    required this.foreground,
  });
  final String text;
  final Color color;
  final Color foreground;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 4),
        decoration: BoxDecoration(
          color: color,
          borderRadius: BorderRadius.circular(4),
        ),
        child: Text(
          text,
          style: TextStyle(
            color: foreground,
            fontSize: 10,
            fontWeight: FontWeight.w700,
          ),
        ),
      );
}

class _EmptyState extends StatelessWidget {
  const _EmptyState({required this.text});
  final String text;
  @override
  Widget build(BuildContext context) => Card(
        child: SizedBox(
          width: double.infinity,
          child: Padding(
            padding: const EdgeInsets.all(28),
            child: Column(
              children: [
                const Icon(Icons.inbox_outlined, color: _muted, size: 28),
                const SizedBox(height: 8),
                Text(text, style: const TextStyle(color: _muted)),
              ],
            ),
          ),
        ),
      );
}

String _price(double value) => value >= 1000
    ? value.toStringAsFixed(2)
    : value >= 1
        ? value.toStringAsFixed(3)
        : value.toStringAsFixed(4);

String _formatDate(DateTime date) =>
    '${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')} ${date.hour.toString().padLeft(2, '0')}:${date.minute.toString().padLeft(2, '0')}';
