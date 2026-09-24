# The JS bridge: methods are only reached by reflection from the WebView.
-keepclassmembers class ch.kscw.pointhub.web.PointHubBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface
# Manifest-referenced components are kept by AAPT rules automatically.
