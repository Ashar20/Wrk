package com.wrk.app.capture

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import com.wrk.app.episode.ImuStream

/** Accelerometer + gyroscope at the fastest rate the phone offers, sampled off the main thread. */
class ImuRecorder(context: Context) : SensorEventListener {
    private val sm = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val acc = ImuAccumulator()
    private var thread: HandlerThread? = null
    private var startedAtEpochMs = 0L

    val motionDps: Float get() = acc.motionDps

    fun start() {
        val t = HandlerThread("wrk-imu").also { it.start() }
        thread = t
        val h = Handler(t.looper)
        sm.registerListener(this, sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER), SensorManager.SENSOR_DELAY_FASTEST, h)
        sm.registerListener(this, sm.getDefaultSensor(Sensor.TYPE_GYROSCOPE), SensorManager.SENSOR_DELAY_FASTEST, h)
    }

    /** Called at the instant the video starts so both streams share t = 0. */
    fun begin() {
        startedAtEpochMs = System.currentTimeMillis()
        acc.begin(SystemClock.elapsedRealtimeNanos())
    }

    fun stop(): ImuStream {
        sm.unregisterListener(this)
        thread?.quitSafely(); thread = null
        return ImuStream(startedAtEpochMs.toDouble(), acc.samples())
    }

    override fun onSensorChanged(e: SensorEvent) {
        when (e.sensor.type) {
            Sensor.TYPE_ACCELEROMETER -> acc.onAccel(e.values[0], e.values[1], e.values[2])
            Sensor.TYPE_GYROSCOPE -> acc.onGyro(e.timestamp, e.values[0], e.values[1], e.values[2])
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    companion object {
        fun hasGyroscope(context: Context): Boolean =
            (context.getSystemService(Context.SENSOR_SERVICE) as SensorManager).getDefaultSensor(Sensor.TYPE_GYROSCOPE) != null
    }
}
