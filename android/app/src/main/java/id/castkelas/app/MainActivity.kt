package id.castkelas.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import id.castkelas.app.CastState.Phase

class MainActivity : AppCompatActivity() {
    private lateinit var statusText: TextView
    private lateinit var detailText: TextView
    private lateinit var scanButton: Button
    private lateinit var stopButton: Button
    private var pendingLink: JoinLink? = null

    private val scanLauncher = registerForActivityResult(ScanContract()) { result ->
        val text = result.contents ?: return@registerForActivityResult
        val link = JoinLink.parse(text)
        if (link == null) {
            Toast.makeText(this, R.string.error_not_castkelas_qr, Toast.LENGTH_LONG).show()
        } else {
            beginCast(link)
        }
    }

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
            if (grants[Manifest.permission.RECORD_AUDIO] == false) {
                Toast.makeText(this, R.string.warn_no_audio_permission, Toast.LENGTH_LONG).show()
            }
            requestScreenCapture()
        }

    private val projectionLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val link = pendingLink ?: return@registerForActivityResult
            pendingLink = null
            val data = result.data
            if (result.resultCode == RESULT_OK && data != null) {
                CastService.start(this, link, data)
            } else {
                CastState.update(Phase.ERROR, getString(R.string.error_capture_denied))
            }
        }

    private val stateListener: (CastState.State) -> Unit = { render(it) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        statusText = findViewById(R.id.status)
        detailText = findViewById(R.id.detail)
        scanButton = findViewById(R.id.scan)
        stopButton = findViewById(R.id.stop)

        scanButton.setOnClickListener { startScan() }
        stopButton.setOnClickListener { CastService.stop(this) }

        // Only on a fresh launch, so rotating the screen doesn't restart the cast.
        if (savedInstanceState == null) handleDeepLink(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleDeepLink(intent)
    }

    override fun onStart() {
        super.onStart()
        CastState.observe(stateListener)
    }

    override fun onStop() {
        CastState.remove(stateListener)
        super.onStop()
    }

    private fun handleDeepLink(intent: Intent?) {
        val link = intent?.data?.let { JoinLink.parse(it.toString()) } ?: return
        beginCast(link)
    }

    private fun startScan() {
        scanLauncher.launch(
            ScanOptions()
                .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setPrompt(getString(R.string.scan_prompt))
                .setBeepEnabled(false)
                .setOrientationLocked(false),
        )
    }

    private fun beginCast(link: JoinLink) {
        if (CastState.state.isActive) CastService.stop(this)
        pendingLink = link

        val needed = buildList {
            add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) add(Manifest.permission.POST_NOTIFICATIONS)
        }.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }

        if (needed.isEmpty()) requestScreenCapture() else permissionLauncher.launch(needed.toTypedArray())
    }

    private fun requestScreenCapture() {
        val manager = getSystemService(MediaProjectionManager::class.java)
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Whole screen only: teachers switch between apps during a lesson.
            manager.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
        } else {
            manager.createScreenCaptureIntent()
        }
        projectionLauncher.launch(intent)
    }

    private fun render(state: CastState.State) {
        val (title, defaultDetail) = when (state.phase) {
            Phase.IDLE -> R.string.title_idle to getString(R.string.detail_idle)
            Phase.PREPARING, Phase.WAITING_LAPTOP, Phase.CONNECTING -> R.string.title_connecting to ""
            Phase.STREAMING -> R.string.title_streaming to getString(R.string.detail_streaming)
            Phase.RECONNECTING -> R.string.title_reconnecting to ""
            Phase.ERROR -> R.string.title_error to ""
        }
        statusText.setText(title)
        detailText.text = state.message.ifEmpty { defaultDetail }
        scanButton.visibility = if (state.isActive) View.GONE else View.VISIBLE
        stopButton.visibility = if (state.isActive) View.VISIBLE else View.GONE
    }
}
