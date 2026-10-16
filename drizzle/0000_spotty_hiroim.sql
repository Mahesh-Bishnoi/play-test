CREATE TABLE `case_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`suite_run_id` text NOT NULL,
	`case_id` text NOT NULL,
	`status` text NOT NULL,
	`duration_ms` integer,
	`video_path` text
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`base_url` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `step_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`case_run_id` text NOT NULL,
	`step_id` text NOT NULL,
	`order` integer NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`screenshot_path` text,
	`duration_ms` integer
);
--> statement-breakpoint
CREATE TABLE `suite_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`suite_id` text,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`report_html_path` text,
	`report_pdf_path` text
);
--> statement-breakpoint
CREATE TABLE `suite_test_cases` (
	`suite_id` text NOT NULL,
	`case_id` text NOT NULL,
	PRIMARY KEY(`suite_id`, `case_id`)
);
--> statement-breakpoint
CREATE TABLE `test_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`url` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `test_data` (
	`case_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`source` text DEFAULT 'kv' NOT NULL,
	PRIMARY KEY(`case_id`, `key`)
);
--> statement-breakpoint
CREATE TABLE `test_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`order` integer NOT NULL,
	`action` text NOT NULL,
	`selector` text,
	`value` text,
	`timeout_ms` integer,
	`edited_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `test_suites` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
