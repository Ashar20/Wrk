package com.wrk.app.account

/** Who someone is being in Wrk. One sign-in, three ways to use it. */
enum class Role(val label: String, val blurb: String) {
    Contributor("Contributor", "Record short everyday tasks and get paid for each accepted take."),
    Verifier("Verifier", "Review takes that the automatic checks couldn't call, and earn a fee for each decision."),
    Buyer("Buyer", "Post tasks, watch the takes come in, and download the dataset.");

    /** Every role is tied to a signed-in identity on the validator: it records a contributor's takes on their behalf too. */
    val needsSession: Boolean get() = true
}
