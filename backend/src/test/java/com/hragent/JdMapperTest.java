package com.hragent;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.hragent.entity.Jd;
import com.hragent.repository.JdMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.annotation.Transactional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

@SpringBootTest
@ActiveProfiles("test")
@Transactional
class JdMapperTest {

    @Autowired
    private JdMapper jdMapper;

    @Test
    void insertAndSelectById() {
        Jd jd = new Jd();
        jd.setTitle("Java 后端工程师");
        jd.setExternalJd("负责后端服务开发");
        jd.setInternalNotes("关键词:Java SpringBoot MySQL");
        jd.setSalaryMin(20000);
        jd.setSalaryMax(35000);
        jd.setStatus("ACTIVE");
        jdMapper.insert(jd);

        assertNotNull(jd.getId());

        Jd loaded = jdMapper.selectById(jd.getId());
        assertNotNull(loaded);
        assertEquals("Java 后端工程师", loaded.getTitle());
        assertEquals("ACTIVE", loaded.getStatus());
        assertEquals(20000, loaded.getSalaryMin());
        assertNotNull(loaded.getCreatedAt());
    }

    @Test
    void updateById() {
        Jd jd = new Jd();
        jd.setTitle("测试岗位");
        jdMapper.insert(jd);

        jd.setTitle("更新后的岗位");
        jd.setStatus("CLOSED");
        jdMapper.updateById(jd);

        Jd loaded = jdMapper.selectById(jd.getId());
        assertEquals("更新后的岗位", loaded.getTitle());
        assertEquals("CLOSED", loaded.getStatus());
    }

    @Test
    void deleteById() {
        Jd jd = new Jd();
        jd.setTitle("待删除岗位");
        jdMapper.insert(jd);

        jdMapper.deleteById(jd.getId());
        assertNull(jdMapper.selectById(jd.getId()));
    }

    @Test
    void selectCount() {
        long before = jdMapper.selectCount(new LambdaQueryWrapper<>());
        Jd jd = new Jd();
        jd.setTitle("计数岗位");
        jdMapper.insert(jd);

        assertTrue(jdMapper.selectCount(new LambdaQueryWrapper<>()) == before + 1);
    }
}
