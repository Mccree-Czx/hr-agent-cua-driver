package com.hragent.storage;

import java.io.InputStream;

/**
 * 文件存储抽象(简历 PDF 等):
 * - MinioStorageService:MinIO 对象存储(默认)
 * - LocalFileStorageService:本地磁盘(测试/无 Docker 环境)
 * 通过 hr-agent.storage.type 配置切换,业务层零改动。
 */
public interface StorageService {

    /** 保存文件,返回对象键;已存在则覆盖 */
    String save(String objectKey, byte[] content, String contentType);

    /** 保存文件(流) */
    String save(String objectKey, InputStream content, long size, String contentType);

    /** 读取文件字节;不存在返回 null */
    byte[] load(String objectKey);

    /** 文件是否存在 */
    boolean exists(String objectKey);
}
