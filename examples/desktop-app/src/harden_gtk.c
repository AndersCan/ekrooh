// Linux half of `ekrooh_harden` (see src/main.zig): a `decide-policy` handler
// that asks `ekrooh_nav_decide` about every navigation and new-window request,
// and clipboard read access turned back off (webview/webview enables
// `javascript-can-access-clipboard`). WebKitGTK does not say which frame a
// navigation targets, so every navigation is judged as `unknown_frame`.
#include <gio/gio.h>
#include <webkit2/webkit2.h>

extern int ekrooh_nav_decide(const char *url, int kind, int user_gesture);

enum { kNewWindow = 2, kUnknownFrame = 3 };
enum { kAllow = 0, kOpenExternal = 2 };

static gboolean ekrooh_on_decide_policy(WebKitWebView *web_view, WebKitPolicyDecision *decision,
                                        WebKitPolicyDecisionType type, gpointer user_data) {
  (void)web_view;
  (void)user_data;
  if (type != WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION &&
      type != WEBKIT_POLICY_DECISION_TYPE_NEW_WINDOW_ACTION) {
    return FALSE; // responses: WebKit's default handling
  }
  WebKitNavigationAction *action = webkit_navigation_policy_decision_get_navigation_action(
      WEBKIT_NAVIGATION_POLICY_DECISION(decision));
  WebKitURIRequest *request = webkit_navigation_action_get_request(action);
  const char *uri = webkit_uri_request_get_uri(request);
  int kind = type == WEBKIT_POLICY_DECISION_TYPE_NEW_WINDOW_ACTION ? kNewWindow : kUnknownFrame;
  int gesture = webkit_navigation_action_get_navigation_type(action) ==
                    WEBKIT_NAVIGATION_TYPE_LINK_CLICKED &&
                webkit_navigation_action_is_user_gesture(action);
  int verdict = uri ? ekrooh_nav_decide(uri, kind, gesture) : 1;
  if (verdict == kAllow) {
    webkit_policy_decision_use(decision);
    return TRUE;
  }
  webkit_policy_decision_ignore(decision);
  if (verdict == kOpenExternal) {
    g_app_info_launch_default_for_uri(uri, NULL, NULL);
  }
  return TRUE;
}

int ekrooh_harden(void *browser) {
  if (browser == NULL) return -1;
  WebKitWebView *web_view = WEBKIT_WEB_VIEW(browser);
  WebKitSettings *settings = webkit_web_view_get_settings(web_view);
  webkit_settings_set_javascript_can_access_clipboard(settings, FALSE);
  g_signal_connect(web_view, "decide-policy", G_CALLBACK(ekrooh_on_decide_policy), NULL);
  return webkit_settings_get_javascript_can_access_clipboard(settings) ? -2 : 0;
}
