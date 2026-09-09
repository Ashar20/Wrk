package com.wrk.app.design

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

private val scheme = lightColorScheme(
    primary = WrkColors.ink,
    onPrimary = WrkColors.onInk,
    background = WrkColors.bone,
    onBackground = WrkColors.foreground,
    surface = WrkColors.paper,
    onSurface = WrkColors.foreground,
)

@Composable
fun WrkTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = scheme, content = content)
}
