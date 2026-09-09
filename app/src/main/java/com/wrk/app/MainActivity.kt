package com.wrk.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import com.wrk.app.design.WrkColors
import com.wrk.app.design.WrkShape
import com.wrk.app.design.WrkTheme
import com.wrk.app.design.WrkType

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            WrkTheme {
                Box(Modifier.fillMaxSize().background(WrkColors.bone).padding(WrkShape.gutter)) {
                    Text("Wrk", style = WrkType.headline, color = WrkColors.foreground)
                }
            }
        }
    }
}
