package dev.datalens

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.ide.ui.LafManagerListener
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.WriteAction
import com.intellij.openapi.editor.colors.EditorColors
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.fileChooser.FileChooserFactory
import com.intellij.openapi.fileChooser.FileSaverDescriptor
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorState
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.UserDataHolderBase
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileContentChangeEvent
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.ui.JBColor
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefLoadHandlerAdapter
import java.awt.Color
import java.awt.datatransfer.StringSelection
import java.beans.PropertyChangeListener
import java.beans.PropertyChangeSupport
import java.util.Base64
import javax.swing.JComponent

/**
 * Hosts the shared Data Lens web UI in JCEF. The UI parses and serialises the file itself;
 * this class only moves bytes (base64) and maps messages to IDE services.
 * JetBrains IDEs autosave, so the UI saves automatically shortly after each edit.
 */
class DataLensFileEditor(private val project: Project, private val file: VirtualFile) : UserDataHolderBase(), FileEditor {
    private val browser = JBCefBrowser.createBuilder().setOffScreenRendering(false).build()
    private val query = JBCefJSQuery.create(browser as JBCefBrowserBase)
    private val pcs = PropertyChangeSupport(this)
    private val gson = Gson()
    @Volatile private var modified = false
    @Volatile private var writing = false

    init {
        Disposer.register(this, browser)
        Disposer.register(this, query)
        query.addHandler { json ->
            ApplicationManager.getApplication().invokeLater { handle(json) }
            null
        }
        browser.jbCefClient.addLoadHandler(object : CefLoadHandlerAdapter() {
            override fun onLoadEnd(b: CefBrowser, frame: CefFrame, httpStatusCode: Int) {
                if (frame.isMain) b.executeJavaScript("window.__dataLensPost = function(m) { ${query.inject("m")} };", b.url, 0)
            }
        }, browser.cefBrowser)

        val html = javaClass.getResource("/webview/index.html")?.readText()
            ?: "<body style='font-family:sans-serif;padding:2em'>Data Lens UI missing — rebuild the plugin.</body>"
        browser.loadHTML(html)

        val bus = ApplicationManager.getApplication().messageBus.connect(this)
        // Reload when the file changes outside the editor (VCS checkout, another tool…).
        bus.subscribe(VirtualFileManager.VFS_CHANGES, object : BulkFileListener {
            override fun after(events: List<VFileEvent>) {
                if (writing || modified) return
                if (events.any { it is VFileContentChangeEvent && it.file == file }) {
                    post(JsonObject().apply { addProperty("type", "reload"); addData(this, file.contentsToByteArray()) })
                }
            }
        })
        // Follow IDE theme switches.
        bus.subscribe(LafManagerListener.TOPIC, LafManagerListener {
            post(themeMessage().apply { addProperty("type", "theme") })
        })
    }

    private fun handle(json: String) {
        val msg = runCatching { JsonParser.parseString(json).asJsonObject }.getOrNull() ?: return
        when (msg.get("type")?.asString) {
            "ready" -> sendInit()
            "edit" -> setModified(true)
            "save" -> write(decode(msg))
            "export" -> export(msg.get("fileName")?.asString ?: "export", decode(msg))
            "copy" -> CopyPasteManager.getInstance().setContents(StringSelection(msg.get("text")?.asString ?: ""))
            "notify" -> notify(msg.get("message")?.asString ?: "", msg.get("level")?.asString == "error")
            "command" -> if (msg.get("id")?.asString == "reopenAsText") {
                FileEditorManager.getInstance(project).setSelectedEditor(file, "text-editor")
            }
        }
    }

    private fun sendInit() {
        val m = themeMessage()
        m.addProperty("type", "init")
        m.addProperty("fileName", file.name)
        m.addProperty("readonly", !file.isWritable)
        addData(m, file.contentsToByteArray())
        m.add("settings", JsonObject().apply { addProperty("autosave", true) })
        post(m)
    }

    private fun addData(m: JsonObject, bytes: ByteArray) {
        m.addProperty("data", Base64.getEncoder().encodeToString(bytes))
        m.addProperty("dataEncoding", "base64")
    }

    private fun decode(msg: JsonObject): ByteArray = Base64.getDecoder().decode(msg.get("data")?.asString ?: "")

    private fun write(bytes: ByteArray) {
        try {
            writing = true
            WriteAction.run<Exception> { file.setBinaryContent(bytes) }
            setModified(false)
            post(JsonObject().apply { addProperty("type", "saved") })
        } catch (e: Exception) {
            notify("Could not save ${file.name}: ${e.message}", true)
        } finally {
            writing = false
        }
    }

    private fun export(name: String, bytes: ByteArray) {
        val ext = name.substringAfterLast('.', "")
        val descriptor = FileSaverDescriptor("Export", "Export data from ${file.name}", *(if (ext.isNotEmpty()) arrayOf(ext) else emptyArray()))
        val target = FileChooserFactory.getInstance().createSaveFileDialog(descriptor, project).save(file.parent, name) ?: return
        try {
            WriteAction.run<Exception> {
                val vf = target.getVirtualFile(true) ?: throw IllegalStateException("Cannot create ${target.file}")
                vf.setBinaryContent(bytes)
            }
            notify("Exported ${target.file.name}", false)
        } catch (e: Exception) {
            notify("Export failed: ${e.message}", true)
        }
    }

    private fun notify(text: String, error: Boolean) {
        NotificationGroupManager.getInstance().getNotificationGroup("Data Lens")
            .createNotification(text, if (error) NotificationType.ERROR else NotificationType.INFORMATION)
            .notify(project)
    }

    private fun post(msg: JsonObject) {
        val js = "window.__dataLensReceive && window.__dataLensReceive(${gson.toJson(msg)});"
        browser.cefBrowser.executeJavaScript(js, browser.cefBrowser.url, 0)
    }

    /** Map the IDE Look & Feel onto the UI's CSS tokens so it looks native in every theme. */
    private fun themeMessage(): JsonObject {
        val scheme = EditorColorsManager.getInstance().globalScheme
        fun hex(c: Color?) = c?.let { String.format("#%02x%02x%02x", it.red, it.green, it.blue) }
        val vars = linkedMapOf(
            "--bg" to hex(scheme.defaultBackground),
            "--fg" to hex(scheme.defaultForeground),
            "--panel" to hex(UIUtil.getPanelBackground()),
            "--header" to hex(UIUtil.getPanelBackground()),
            "--border" to hex(JBColor.border()),
            "--muted" to hex(UIUtil.getContextHelpForeground()),
            "--accent" to hex(JBUI.CurrentTheme.Focus.focusColor()),
            "--sel" to hex(scheme.getColor(EditorColors.SELECTION_BACKGROUND_COLOR)),
            "--input-bg" to hex(UIUtil.getTextFieldBackground()),
            "--input-fg" to hex(UIUtil.getTextFieldForeground()),
            "--menu-bg" to hex(UIUtil.getListBackground()),
            "--menu-fg" to hex(UIUtil.getListForeground()),
            "--menu-sel" to hex(UIUtil.getListSelectionBackground(true)),
            "--menu-sel-fg" to hex(UIUtil.getListSelectionForeground(true)),
            "--btn-bg" to hex(JBUI.CurrentTheme.Button.defaultButtonColorStart()),
            "--font" to "'${UIUtil.getLabelFont().family}', system-ui, sans-serif",
            "--mono" to "'${scheme.editorFontName}', ui-monospace, monospace",
            "--fs" to "${UIUtil.getLabelFont().size}px",
        )
        return JsonObject().apply {
            addProperty("theme", if (JBColor.isBright()) "light" else "dark")
            add("cssVars", JsonObject().apply { vars.forEach { (k, v) -> if (v != null) addProperty(k, v) } })
        }
    }

    private fun setModified(value: Boolean) {
        val old = modified
        modified = value
        if (old != value) pcs.firePropertyChange(FileEditor.PROP_MODIFIED, old, value)
    }

    override fun getComponent(): JComponent = browser.component
    override fun getPreferredFocusedComponent(): JComponent = browser.component
    override fun getName(): String = "Data Lens"
    override fun getFile(): VirtualFile = file
    override fun setState(state: FileEditorState) {}
    override fun isModified(): Boolean = modified
    override fun isValid(): Boolean = file.isValid
    override fun addPropertyChangeListener(listener: PropertyChangeListener) = pcs.addPropertyChangeListener(listener)
    override fun removePropertyChangeListener(listener: PropertyChangeListener) = pcs.removePropertyChangeListener(listener)
    override fun dispose() {}
}
