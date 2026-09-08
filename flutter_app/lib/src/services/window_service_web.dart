class WindowService {
  bool get isSupported => false;

  Future<void> initialize() async {}
  Future<void> setAlwaysOnTop(bool value) async {}
  Future<void> setCompactMode(bool value) async {}
  Future<void> setOpacity(double value) async {}
  Future<void> beginDrag() async {}

  bool get isAlwaysOnTop => false;
  bool get isCompact => false;
  double get opacity => 1;

  void dispose() {}
}
