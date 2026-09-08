import 'package:flutter_test/flutter_test.dart';

import 'package:nofx_research/main.dart';

void main() {
  testWidgets('NOFX app smoke test', (WidgetTester tester) async {
    // Build our app and trigger a frame.
    await tester.pumpWidget(const NofxApp());

    // Verify that the responsive home page is rendered.
    expect(find.text('分析工作台'), findsWidgets);
  });
}
