package com.hragent.executor;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.util.Optional;

/**
 * 从 CLI 输出中提取 JSON。
 * liepin-cli 的 --json 输出可能混有中文提示行(如"正在跳转到..."),JSON 从第一个 '[' 或 '{' 开始。
 */
public final class JsonExtractor {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private JsonExtractor() {
    }

    public static Optional<JsonNode> parse(String output) {
        if (output == null || output.isBlank()) {
            return Optional.empty();
        }
        int arrayStart = output.indexOf('[');
        int objectStart = output.indexOf('{');
        int start;
        if (arrayStart < 0) {
            start = objectStart;
        } else if (objectStart < 0) {
            start = arrayStart;
        } else {
            start = Math.min(arrayStart, objectStart);
        }
        if (start < 0) {
            return Optional.empty();
        }
        String jsonPart = output.substring(start).trim();
        try {
            return Optional.of(MAPPER.readTree(jsonPart));
        } catch (Exception e) {
            return Optional.empty();
        }
    }
}
