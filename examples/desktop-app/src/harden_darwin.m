// macOS half of `ekrooh_harden` (see src/main.zig): a WKNavigationDelegate
// that asks `ekrooh_nav_decide` about every navigation, and clipboard read
// access turned back off (webview/webview enables `javaScriptCanAccessClipboard`
// and `DOMPasteAllowed` for every page). webview/webview sets no navigation
// delegate of its own, so this one is the only policy.
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>

extern int ekrooh_nav_decide(const char *url, int kind, int user_gesture);

enum { kMainFrame = 0, kSubFrame = 1, kNewWindow = 2 };
enum { kAllow = 0, kOpenExternal = 2 };

@interface EkroohNavigationDelegate : NSObject <WKNavigationDelegate>
@end

@implementation EkroohNavigationDelegate
- (void)webView:(WKWebView *)webView
    decidePolicyForNavigationAction:(WKNavigationAction *)action
                    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
  NSURL *url = action.request.URL;
  const char *text = url.absoluteString.UTF8String;
  int kind = action.targetFrame == nil ? kNewWindow
             : action.targetFrame.isMainFrame ? kMainFrame
                                              : kSubFrame;
  int gesture = action.navigationType == WKNavigationTypeLinkActivated;
  int decision = text ? ekrooh_nav_decide(text, kind, gesture) : 1;
  if (decision == kAllow) {
    decisionHandler(WKNavigationActionPolicyAllow);
    return;
  }
  decisionHandler(WKNavigationActionPolicyCancel);
  if (decision == kOpenExternal) {
    [[NSWorkspace sharedWorkspace] openURL:url];
  }
}
@end

// WKWebView.navigationDelegate is weak: keep the one delegate alive for the
// process (there is one window).
static EkroohNavigationDelegate *ekroohDelegate;

int ekrooh_harden(void *browser) {
  WKWebView *webView = (__bridge WKWebView *)browser;
  if (webView == nil) return -1;
  if (ekroohDelegate == nil) ekroohDelegate = [EkroohNavigationDelegate new];
  webView.navigationDelegate = ekroohDelegate;

  // The configuration getter returns a copy, but it shares the live
  // WKPreferences object, so this reaches the existing page settings.
  WKPreferences *preferences = webView.configuration.preferences;
  @try {
    [preferences setValue:@NO forKey:@"javaScriptCanAccessClipboard"];
    [preferences setValue:@NO forKey:@"DOMPasteAllowed"];
    if ([[preferences valueForKey:@"javaScriptCanAccessClipboard"] boolValue]) return -2;
  } @catch (NSException *e) {
    return -3;
  }
  return 0;
}
