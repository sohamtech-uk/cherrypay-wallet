-- Cherry Pay Wallet schema, MySQL 8.4. Safe to re-run.
-- Connect to the dedicated DB_NAME database before running this script.
CREATE TABLE IF NOT EXISTS wallet_accounts (
 id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 webauthn_user_id VARCHAR(128) NOT NULL,
 created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS wallet_credentials (
 id VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 public_key TEXT NOT NULL,
 counter BIGINT UNSIGNED NOT NULL DEFAULT 0,
 transports JSON NOT NULL,
 created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY (account_id) REFERENCES wallet_accounts(id),
 INDEX (account_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS wallet_challenges (
 id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 purpose ENUM('register_initial','register_backup','authenticate') NOT NULL,
 challenge VARCHAR(512) NOT NULL,
 session_hash CHAR(64) NULL,
 expires_at DATETIME(3) NOT NULL,
 FOREIGN KEY (account_id) REFERENCES wallet_accounts(id),
 INDEX (expires_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS wallet_sessions (
 token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 expires_at DATETIME(3) NOT NULL,
 FOREIGN KEY (account_id) REFERENCES wallet_accounts(id),
 INDEX (expires_at)
) ENGINE=InnoDB;
