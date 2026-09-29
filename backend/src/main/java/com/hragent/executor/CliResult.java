package com.hragent.executor;

/** CLI 执行结果 */
public record CliResult(
        int exitCode,
        String stdout,
        String stderr,
        boolean timedOut) {

    public String combined() {
        return (stdout == null ? "" : stdout) + "\n" + (stderr == null ? "" : stderr);
    }
}
