package com.hragent;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

@SpringBootApplication
@ConfigurationPropertiesScan
@MapperScan("com.hragent.repository")
public class HrAgentApplication {

    public static void main(String[] args) {
        SpringApplication.run(HrAgentApplication.class, args);
    }
}
