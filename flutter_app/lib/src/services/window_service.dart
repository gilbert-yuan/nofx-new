import 'window_service_io.dart'
    if (dart.library.html) 'window_service_web.dart';

export 'window_service_io.dart'
    if (dart.library.html) 'window_service_web.dart';

extension WindowServicePointerHovering on WindowService {
  Future<void> setPointerHovering(bool value) async {}
}
