package com.wrk.app.capture

/**
 * The box a contributor aims their hands at, in [0,1] of the frame. The validator scores framing against the
 * same region, so what they see is what they are measured on. Biased low: a head-mounted camera points where
 * the head points while the hands work below that line.
 */
object GuideRegion {
    const val X0 = 0.12f
    const val Y0 = 0.38f
    const val X1 = 0.88f
    const val Y1 = 0.92f
}

/** The 21-point hand model's bones and the joints a hand actually pivots about. */
object HandSkeleton {
    val connections: List<Pair<Int, Int>> = listOf(
        0 to 1, 1 to 2, 2 to 3, 3 to 4,
        0 to 5, 5 to 6, 6 to 7, 7 to 8,
        5 to 9, 9 to 10, 10 to 11, 11 to 12,
        9 to 13, 13 to 14, 14 to 15, 15 to 16,
        13 to 17, 17 to 18, 18 to 19, 19 to 20,
        0 to 17,
    )
    val pivots = listOf(0, 1, 2, 5, 9, 13, 17)
}
