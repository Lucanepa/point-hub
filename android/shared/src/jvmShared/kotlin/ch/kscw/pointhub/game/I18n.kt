package ch.kscw.pointhub.game

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.json.JSONObject

/**
 * The Game tab's languages: the board's web/i18n/<language>.json, the same words as the console.
 * Keyed by the English as displayed. Text with no entry stays English, and text without letters
 * (a score) is never looked up.
 */
object I18n {
    private class Words(val exact: Map<String, String>, val patterns: List<Pair<Regex, String>>) {
        val seen = HashMap<String, String>()
    }

    private var words by mutableStateOf<Words?>(null)

    fun clear() { words = null }

    fun load(json: JSONObject) {
        val exact = HashMap<String, String>()
        json.optJSONObject("exact")?.let { o -> for (k in o.keys()) exact[k] = o.optString(k) }
        val patterns = ArrayList<Pair<Regex, String>>()
        json.optJSONArray("patterns")?.let { a ->
            for (i in 0 until a.length()) {
                val p = a.optJSONArray(i) ?: continue
                try { patterns.add(Regex(p.getString(0)) to p.getString(1)) } catch (_: Exception) { /* one bad line, not all */ }
            }
        }
        words = Words(exact, patterns)
    }

    fun t(text: String): String {
        val w = words ?: return text
        if (text.none { it.isLetter() }) return text
        w.seen[text]?.let { return it }
        val out = w.exact[text]
            ?: w.patterns.firstOrNull { it.first.matches(text) }?.let { (re, to) -> re.replace(text, to) }
            ?: text
        // Team names and clocks go through here too, so the memory stays bounded.
        if (w.seen.size > 2_000) w.seen.clear()
        w.seen[text] = out
        return out
    }
}
