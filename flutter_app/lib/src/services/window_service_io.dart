import 'dart:ui';

import 'package:flutter/foundation.dart';
import 'package:window_manager/window_manager.dart';

class WindowService extends WindowListener {
  bool get isSupported =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.windows;

  bool _initialized = false;
  bool _alwaysOnTop = false;
  bool _compact = false;
  bool _focused = true;
  bool _pointerHovering = false;
  double _opacity = 1;

  bool get isAlwaysOnTop => _alwaysOnTop;
  bool get isCompact => _compact;
  double get opacity => _opacity;

  Future<void> initialize() async {
    if (!isSupported || _initialized) return;
    await windowManager.ensureInitialized();
    windowManager.addListener(this);
    const options = WindowOptions(
      size: Size(1180, 760),
      minimumSize: Size(820, 600),
      center: true,
      title: 'NOFX 盯盘研究工作台',
      backgroundColor: Color(0xfff7faf8),
      skipTaskbar: false,
      titleBarStyle: TitleBarStyle.hidden,
    );
    await windowManager.waitUntilReadyToShow(options, () async {
      await windowManager.show();
      await windowManager.focus();
    });
    _initialized = true;
  }

  Future<void> setAlwaysOnTop(bool value) async {
    _alwaysOnTop = value;
    if (isSupported) await windowManager.setAlwaysOnTop(value);
  }

  Future<void> setCompactMode(bool value) async {
    _compact = value;
    if (!isSupported) return;
    await windowManager
        .setSize(value ? const Size(420, 620) : const Size(1180, 760));
    await windowManager
        .setMinimumSize(value ? const Size(360, 520) : const Size(820, 600));
  }

  Future<void> setOpacity(double value) async {
    _opacity = value.clamp(.3, 1.0).toDouble();
    await _applyOpacity();
  }

  Future<void> setPointerHovering(bool value) async {
    if (_pointerHovering == value) return;
    _pointerHovering = value;
    await _applyOpacity();
  }

  Future<void> beginDrag() async {
    if (isSupported) await windowManager.startDragging();
  }

  void dispose() {
    if (isSupported) windowManager.removeListener(this);
  }

  @override
  void onWindowBlur() {
    _focused = false;
    _applyOpacity();
  }

  @override
  void onWindowFocus() {
    _focused = true;
    _applyOpacity();
  }

  Future<void> _applyOpacity() async {
    if (!isSupported) return;
    final effective = _focused && _pointerHovering
        ? _opacity
        : (_opacity * .72).clamp(0.0, 1.0).toDouble();
    await windowManager.setOpacity(effective);
  }
}
