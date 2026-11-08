package com.dogo.pos;

import android.os.Bundle;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private long lastBackAt = 0;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Back = close the open sheet/menu, else go to the previous page. Only on the home screen
        // does it ask for a second press to exit, so the app is never closed by accident.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                final WebView wv = getBridge() != null ? getBridge().getWebView() : null;
                if (wv == null) { finish(); return; }
                wv.evaluateJavascript(
                    "(function(){try{return window.DogoBack?window.DogoBack():'none'}catch(e){return 'none'}})()",
                    value -> {
                        String v = value == null ? "" : value;
                        if (v.contains("handled")) return;
                        if (v.contains("none") && wv.canGoBack()) { wv.goBack(); return; }
                        long now = System.currentTimeMillis();
                        if (now - lastBackAt < 2000) { finish(); return; }
                        lastBackAt = now;
                        Toast.makeText(MainActivity.this, "Press back again to exit", Toast.LENGTH_SHORT).show();
                    });
            }
        });
    }
}
