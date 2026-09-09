package com.wrk.app.design

import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.wrk.app.R

@OptIn(ExperimentalTextApi::class)
private fun variable(res: Int, weight: Int) = Font(
    res,
    weight = FontWeight(weight),
    variationSettings = FontVariation.Settings(FontVariation.weight(weight)),
)

val Manrope = FontFamily(
    variable(R.font.manrope, 400),
    variable(R.font.manrope, 500),
    variable(R.font.manrope, 600),
    variable(R.font.manrope, 700),
)

val GeistMono = FontFamily(variable(R.font.geist_mono, 400))

private const val TABULAR = "tnum"

object WrkType {
    val figureHero = TextStyle(fontFamily = Manrope, fontWeight = FontWeight.SemiBold, fontSize = 52.sp, lineHeight = 50.sp, letterSpacing = (-0.035 * 52).sp, fontFeatureSettings = TABULAR)
    val figureLead = TextStyle(fontFamily = Manrope, fontWeight = FontWeight.SemiBold, fontSize = 34.sp, lineHeight = 32.sp, letterSpacing = (-0.035 * 34).sp, fontFeatureSettings = TABULAR)
    val figureInline = TextStyle(fontFamily = Manrope, fontWeight = FontWeight.SemiBold, fontSize = 17.sp, lineHeight = 16.sp, letterSpacing = (-0.035 * 17).sp, fontFeatureSettings = TABULAR)
    val headline = TextStyle(fontFamily = Manrope, fontWeight = FontWeight.SemiBold, fontSize = 38.sp, lineHeight = 40.sp, letterSpacing = (-0.03 * 38).sp)
    val title = TextStyle(fontFamily = Manrope, fontWeight = FontWeight.SemiBold, fontSize = 19.sp, lineHeight = 25.sp, letterSpacing = (-0.025 * 19).sp)
    val body = TextStyle(fontFamily = Manrope, fontWeight = FontWeight.Normal, fontSize = 14.sp, lineHeight = 23.sp)
    val label = TextStyle(fontFamily = Manrope, fontWeight = FontWeight.Medium, fontSize = 11.sp, lineHeight = 13.sp, letterSpacing = 0.005.sp)
    val data = TextStyle(fontFamily = GeistMono, fontWeight = FontWeight.Normal, fontSize = 12.sp, fontFeatureSettings = TABULAR)
}
