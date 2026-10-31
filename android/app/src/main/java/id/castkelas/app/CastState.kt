package id.castkelas.app

import android.os.Handler
import android.os.Looper
import java.util.concurrent.CopyOnWriteArraySet

/** Cast status shared between [CastService] and the UI. */
object CastState {
    enum class Phase { IDLE, PREPARING, WAITING_LAPTOP, CONNECTING, STREAMING, RECONNECTING, ERROR }

    data class State(val phase: Phase, val message: String = "") {
        val isActive: Boolean
            get() = phase != Phase.IDLE && phase != Phase.ERROR
    }

    private val main = Handler(Looper.getMainLooper())
    private val listeners = CopyOnWriteArraySet<(State) -> Unit>()

    @Volatile
    var state = State(Phase.IDLE)
        private set

    fun update(phase: Phase, message: String = "") {
        val next = State(phase, message)
        state = next
        main.post { listeners.forEach { it(next) } }
    }

    fun observe(listener: (State) -> Unit) {
        listeners += listener
        listener(state)
    }

    fun remove(listener: (State) -> Unit) {
        listeners -= listener
    }
}
