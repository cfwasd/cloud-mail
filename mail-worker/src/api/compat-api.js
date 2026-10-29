import app from '../hono/hono';
import orm from '../entity/orm';
import email from '../entity/email';
import userService from '../service/user-service';
import accountService from '../service/account-service';
import { eq, and, desc, sql } from 'drizzle-orm';
import dayjs from 'dayjs';

function checkAuth(c) {
	const adminToken = c.req.header('X-Admin-Token');
	const authHeader = c.req.header('Authorization') || '';
	const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
	const token = adminToken || bearerToken;
	return Boolean(token && (token === c.env.jwt_secret || (c.env.admin_token && token === c.env.admin_token)));
}

function getEffectiveDomain(c, requestedDomain) {
	if (requestedDomain) {
		return requestedDomain.replace(/^@/, '').toLowerCase().trim();
	}
	let domains = c.env.domain;
	if (typeof domains === 'string') {
		try {
			domains = JSON.parse(domains);
		} catch {
			domains = [domains];
		}
	}
	if (Array.isArray(domains) && domains.length > 0) {
		return String(domains[0]).replace(/^@/, '').toLowerCase().trim();
	}
	return '';
}

// 批量创建临时邮箱（同时兼容 /mailboxes 和 /emails 路径）
async function handleCreateMailboxes(c) {
	if (!checkAuth(c)) {
		return c.json({ code: 401, message: 'Unauthorized' }, 401);
	}

	const body = await c.req.json().catch(() => ({}));
	const count = Math.min(Math.max(parseInt(body.count || body.quantity || 1), 1), 50);
	const domain = getEffectiveDomain(c, body.domain);

	if (!domain) {
		return c.json({ code: 400, message: 'Domain not configured' }, 400);
	}

	const now = dayjs().format('YYYY-MM-DD HH:mm:ss');
	const adminUser = await userService.selectByEmailIncludeDel(c, c.env.admin);
	const adminUserId = adminUser ? adminUser.userId : 1;

	const generatedEmails = [];
	const insertValues = [];

	for (let i = 0; i < count; i++) {
		const randomPrefix = Math.random().toString(36).substring(2, 10);
		const newEmail = `${randomPrefix}@${domain}`;
		generatedEmails.push(newEmail);
		insertValues.push({
			email: newEmail,
			name: randomPrefix,
			userId: adminUserId,
			sort: 0,
			isDel: 0,
			allReceive: 0,
			createTime: now
		});
	}

	try {
		await accountService.insertList(c, insertValues);
	} catch (e) {
		console.error('Batch insert account failed:', e);
	}

	return c.json({
		code: 200,
		success: true,
		data: generatedEmails
	});
}

app.post('/mailboxes', handleCreateMailboxes);
app.post('/emails', handleCreateMailboxes);

// 拉取邮箱收到的邮件（兼容 /messages）
app.get('/messages', async (c) => {
	if (!checkAuth(c)) {
		return c.json({ code: 401, message: 'Unauthorized' }, 401);
	}

	const targetEmail = (c.req.query('email') || c.req.query('address') || c.req.query('to_address') || '').trim().toLowerCase();
	const limit = Math.min(Math.max(parseInt(c.req.query('limit') || 25), 1), 100);

	if (!targetEmail) {
		return c.json({ code: 200, success: true, data: [] });
	}

	const rows = await orm(c)
		.select({
			id: email.emailId,
			message_id: email.emailId,
			to: email.toEmail,
			to_address: email.toEmail,
			recipient: email.toEmail,
			from: email.sendEmail,
			sender: email.sendEmail,
			from_address: email.sendEmail,
			subject: email.subject,
			body: email.content,
			text: email.text,
			content: email.content,
			created_at: email.createTime,
			receivedDateTime: email.createTime
		})
		.from(email)
		.where(
			and(
				sql`${email.toEmail} COLLATE NOCASE = ${targetEmail}`,
				eq(email.type, 0)
			)
		)
		.orderBy(desc(email.emailId))
		.limit(limit);

	return c.json({
		code: 200,
		success: true,
		data: rows
	});
});
