package com.medhub.link

import android.content.Context
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/**
 * Recordings live in the app's external files directory
 * (Android/data/com.medhub/files/recordings), readable over a USB cable without extra
 * storage permissions. Only called from the module's single storage thread.
 */
class RecordingsFolder(private val context: Context) {
  data class Entry(val path: String, val size: Long, val modified: Long)

  private val safeSegment = Regex("^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$")
  private val open = HashMap<Int, FileOutputStream>()
  private var nextId = 1

  fun root(): File {
    val dir = File(context.getExternalFilesDir(null) ?: context.filesDir, "recordings")
    if (!dir.isDirectory && !dir.mkdirs()) throw IOException("Cannot create ${dir.absolutePath}")
    return dir
  }

  private fun segments(path: String): List<String> {
    val parts = if (path.isEmpty()) emptyList() else path.split('/')
    parts.forEach { require(safeSegment.matches(it)) { "Invalid path segment: $it" } }
    return parts
  }

  /** Exclusively creates the file, adding -2, -3… when the name is taken. */
  fun create(folder: String, fileName: String): Pair<Int, String> {
    segments(fileName)
    val dir = segments(folder).fold(root()) { parent, segment -> File(parent, segment) }
    if (!dir.isDirectory && !dir.mkdirs()) throw IOException("Cannot create ${dir.absolutePath}")
    val stem = fileName.substringBeforeLast('.')
    val extension = fileName.substringAfterLast('.', "")
    for (attempt in 1 until 1000) {
      val name = if (attempt == 1) fileName else "$stem-$attempt.$extension"
      val file = File(dir, name)
      if (file.createNewFile()) {
        val id = nextId++
        open[id] = FileOutputStream(file, true)
        return id to file.absolutePath
      }
    }
    throw IOException("No free file name for $fileName")
  }

  fun append(id: Int, text: String) {
    val stream = open[id] ?: throw IOException("File is not open")
    stream.write(text.toByteArray(Charsets.UTF_8))
    stream.flush()
  }

  fun close(id: Int) {
    (open.remove(id) ?: throw IOException("File is not open")).close()
  }

  fun closeAll() {
    open.values.forEach { runCatching { it.close() } }
    open.clear()
  }

  fun list(): List<Entry> {
    val root = root()
    return root
        .walkTopDown()
        .filter { it.isFile && it.extension == "csv" }
        .map { Entry(it.relativeTo(root).invariantSeparatorsPath, it.length(), it.lastModified()) }
        .toList()
  }

  fun read(path: String): String {
    val file = segments(path).fold(root()) { parent, segment -> File(parent, segment) }
    return file.readText(Charsets.UTF_8)
  }
}
