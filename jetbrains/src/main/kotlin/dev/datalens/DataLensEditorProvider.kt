package dev.datalens

import com.intellij.icons.AllIcons
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorPolicy
import com.intellij.openapi.fileEditor.FileEditorProvider
import com.intellij.openapi.fileTypes.FileType
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.jcef.JBCefApp
import javax.swing.Icon

/**
 * One editor, three placements:
 *  - CSV/TSV: a "Data Lens" tab shown first, the text editor still one click away
 *  - Spreadsheets: Data Lens replaces the (useless) binary viewer
 *  - JSON: an extra "Data Lens" tab after the text editor, so code editing stays the default
 */
abstract class DataLensEditorProviderBase(
    private val id: String,
    private val extensions: Set<String>,
    private val policy: FileEditorPolicy,
) : FileEditorProvider, DumbAware {
    override fun accept(project: Project, file: VirtualFile): Boolean =
        !file.isDirectory && file.extension?.lowercase() in extensions && JBCefApp.isSupported()

    override fun createEditor(project: Project, file: VirtualFile): FileEditor = DataLensFileEditor(project, file)
    override fun getEditorTypeId(): String = id
    override fun getPolicy(): FileEditorPolicy = policy
}

class DataLensTableEditorProvider : DataLensEditorProviderBase(
    "data-lens-table", setOf("csv", "tsv", "tab"), FileEditorPolicy.PLACE_BEFORE_DEFAULT_EDITOR,
)

class DataLensSpreadsheetEditorProvider : DataLensEditorProviderBase(
    "data-lens-spreadsheet", setOf("xlsx", "xlsm", "xls", "ods"), FileEditorPolicy.HIDE_DEFAULT_EDITOR,
)

class DataLensJsonEditorProvider : DataLensEditorProviderBase(
    "data-lens-json", setOf("json", "jsonc", "geojson", "jsonl", "ndjson", "har"), FileEditorPolicy.PLACE_AFTER_DEFAULT_EDITOR,
)

/** Registers spreadsheets as a binary file type so the IDE opens them instead of asking for an association. */
object SpreadsheetFileType : FileType {
    override fun getName(): String = "Data Lens Spreadsheet"
    override fun getDescription(): String = "Excel / OpenDocument spreadsheet"
    override fun getDefaultExtension(): String = "xlsx"
    override fun getIcon(): Icon = AllIcons.FileTypes.Any_type
    override fun isBinary(): Boolean = true
    override fun isReadOnly(): Boolean = false
}
