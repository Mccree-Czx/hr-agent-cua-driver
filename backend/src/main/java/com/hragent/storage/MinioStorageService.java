package com.hragent.storage;

import io.minio.BucketExistsArgs;
import io.minio.GetObjectArgs;
import io.minio.MakeBucketArgs;
import io.minio.MinioClient;
import io.minio.PutObjectArgs;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.io.ByteArrayInputStream;
import java.io.InputStream;

/** MinIO 对象存储实现(默认) */
@Slf4j
@Component
@ConditionalOnProperty(name = "hr-agent.storage.type", havingValue = "minio", matchIfMissing = true)
public class MinioStorageService implements StorageService {

    private final MinioClient client;
    private final String bucket;

    public MinioStorageService(com.hragent.config.HrAgentProperties properties) {
        var minio = properties.getStorage().getMinio();
        this.bucket = minio.getBucket();
        this.client = MinioClient.builder()
                .endpoint(minio.getEndpoint())
                .credentials(minio.getAccessKey(), minio.getSecretKey())
                .build();
        try {
            boolean exists = client.bucketExists(BucketExistsArgs.builder().bucket(bucket).build());
            if (!exists) {
                client.makeBucket(MakeBucketArgs.builder().bucket(bucket).build());
                log.info("MinIO bucket '{}' 已创建", bucket);
            }
        } catch (Exception e) {
            // 启动时不阻断:首次上传时会再次失败并告警
            log.warn("MinIO 初始化检查失败(服务可能未启动): {}", e.getMessage());
        }
    }

    @Override
    public String save(String objectKey, byte[] content, String contentType) {
        return save(objectKey, new ByteArrayInputStream(content), content.length, contentType);
    }

    @Override
    public String save(String objectKey, InputStream content, long size, String contentType) {
        try {
            client.putObject(PutObjectArgs.builder()
                    .bucket(bucket)
                    .object(objectKey)
                    .stream(content, size, -1)
                    .contentType(contentType == null ? "application/octet-stream" : contentType)
                    .build());
            return objectKey;
        } catch (Exception e) {
            throw new IllegalStateException("MinIO 上传失败: " + objectKey + " - " + e.getMessage(), e);
        }
    }

    @Override
    public byte[] load(String objectKey) {
        try (InputStream in = client.getObject(GetObjectArgs.builder()
                .bucket(bucket).object(objectKey).build())) {
            return in.readAllBytes();
        } catch (Exception e) {
            return null;
        }
    }

    @Override
    public boolean exists(String objectKey) {
        try (InputStream in = client.getObject(GetObjectArgs.builder()
                .bucket(bucket).object(objectKey).build())) {
            return in != null;
        } catch (Exception e) {
            return false;
        }
    }
}
