package com.wrk.app.upload

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.wrk.app.WrkContainer
import java.util.concurrent.TimeUnit

class UploadWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val id = inputData.getString(KEY) ?: return Result.failure()
        val c = WrkContainer.get(applicationContext)
        return when (c.processor().process(id)) {
            ProcessOutcome.Finished, ProcessOutcome.NeedsContributor -> Result.success()
            ProcessOutcome.TryAgain -> Result.retry()
        }
    }

    companion object {
        private const val KEY = "episode_id"

        /** One job per episode, so a double tap or a retry never uploads twice. */
        fun enqueue(context: Context, episodeId: String) {
            val req = OneTimeWorkRequestBuilder<UploadWorker>()
                .setInputData(workDataOf(KEY to episodeId))
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork("upload-$episodeId", ExistingWorkPolicy.KEEP, req)
        }
    }
}
