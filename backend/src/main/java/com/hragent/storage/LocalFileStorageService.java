package com.hragent.storage;

import com.hragent.config.HrAgentProperties;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;

/** 本地文件系统实现(测试环境/无 Docker 部署) */
@Slf4j
@Component
@ConditionalOnProperty(name = "hr-agent.storage.type", havingValue = "local")
public class LocalFileStorageService implements StorageService {

    private final Path baseDir;

    public LocalFileStorageService(HrAgentProperties properties) {
        this.baseDir = Paths.get(properties.getStorage().getLocalBaseDir());
        try {
            Files.createDirectories(baseDir);
        } catch (IOException e) {
            throw new IllegalStateException("本地存储目录创建失败: " + baseDir, e);
        }
    }

    @Override
    public String save(String objectKey, byte[] content, String contentType) {
        return saveInternal(objectKey, content);
    }

    @Override
    public String save(String objectKey, InputStream content, long size, String contentType) {
        try {
            return saveInternal(objectKey, content.readAllBytes());
        } catch (IOException e) {
            throw new IllegalStateException("读取输入流失败", e);
        }
    }

    private String saveInternal(String objectKey, byte[] content) {
        try {
            Path target = baseDir.resolve(objectKey).normalize();
            if (!target.startsWith(baseDir)) {
                throw new IllegalArgumentException("非法对象键: " + objectKey);
            }
            Files.createDirectories(target.getParent());
            Files.write(target, content);
            return objectKey;
        } catch (IOException e) {
            throw new IllegalStateException("本地保存失败: " + objectKey + " - " + e.getMessage(), e);
        }
    }

    @Override
    public byte[] load(String objectKey) {
        try {
            Path target = baseDir.resolve(objectKey).normalize();
            return Files.readAllBytes(target);
        } catch (IOException e) {
            return null;
        }
    }

    @Override
    public boolean exists(String objectKey) {
        return Files.exists(baseDir.resolve(objectKey).normalize());
    }
}
