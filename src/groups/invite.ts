'use strict';

const _ = require('lodash');

const db = require('../database');
const user = require('../user');
const slugify = require('../slugify');
const plugins = require('../plugins');
const notifications = require('../notifications');

module.exports = function (Groups) {
	Groups.getPending = async function (groupName: string) {
		return await Groups.getUsersFromSet(`group:${groupName}:pending`, ['username', 'userslug', 'picture']);
	};

	Groups.getInvites = async function (groupName: string) {
		return await Groups.getUsersFromSet(`group:${groupName}:invited`, ['username', 'userslug', 'picture']);
	};

	Groups.requestMembership = async function (groupName: string, uid: string) {
		await inviteOrRequestMembership(groupName, uid, 'request');
		const { displayname } = await user.getUserFields(uid, ['username']);

		const [notification, owners] = await Promise.all([
			notifications.create({
				type: 'group-request-membership',
				bodyShort: `[[groups:request.notification-title, ${displayname}]]`,
				bodyLong: `[[groups:request.notification-text, ${displayname}, ${groupName}]]`,
				nid: `group:${groupName}:uid:${uid}:request`,
				path: `/groups/${slugify(groupName)}`,
				from: uid,
			}),
			Groups.getOwners(groupName),
		]);

		await notifications.push(notification, owners);
	};

	Groups.acceptMembership = async function (groupName:string , uid:string) {
		await db.setsRemove([`group:${groupName}:pending`, `group:${groupName}:invited`], uid);
		await Groups.join(groupName, uid);

		const notification = await notifications.create({
			type: 'group-invite',
			bodyShort: `[[groups:membership.accept.notification-title, ${groupName}]]`,
			nid: `group:${groupName}:uid:${uid}:invite-accepted`,
			path: `/groups/${slugify(groupName)}`,
			icon: 'fa-users',
		});
		await notifications.push(notification, [uid]);
	};

	Groups.rejectMembership = async function (groupNames: string |string[], uid: string) {
		if (!Array.isArray(groupNames)) {
			groupNames = [groupNames];
		}
		const sets: string[] = [];
		groupNames.forEach(groupName => sets.push(`group:${groupName}:pending`, `group:${groupName}:invited`));
		await db.setsRemove(sets, uid);
	};

	Groups.invite = async function (groupName: string, uids: string | string[]) {
		uids = Array.isArray(uids) ? uids : [uids];
		uids = await inviteOrRequestMembership(groupName, uids, 'invite');

		const notificationData = await Promise.all(uids.map(uid => notifications.create({
			type: 'group-invite',
			bodyShort: `[[groups:invited.notification-title, ${groupName}]]`,
			bodyLong: '',
			nid: `group:${groupName}:uid:${uid}:invite`,
			path: `/groups/${slugify(groupName)}`,
			icon: 'fa-users',
		})));

		await Promise.all(uids.map((uid, index) => notifications.push(notificationData[index], uid)));
	};

	async function inviteOrRequestMembership(groupName: string, uids: string | string[], type: string) {
		uids = Array.isArray(uids) ? uids : [uids];
		uids = uids.filter(uid => parseInt(uid, 10) > 0);
		const [exists, isMember, isPending, isInvited] = await Promise.all([
			Groups.exists(groupName),
			Groups.isMembers(uids, groupName),
			Groups.isPending(uids, groupName),
			Groups.isInvited(uids, groupName),
		]);

		if (!exists) {
			throw new Error('[[error:no-group]]');
		}

		uids = uids.filter((uid, i) => !isMember[i] && ((type === 'invite' && !isInvited[i]) || (type === 'request' && !isPending[i])));

		const set = type === 'invite' ? `group:${groupName}:invited` : `group:${groupName}:pending`;
		await db.setAdd(set, uids);
		const hookName = type === 'invite' ? 'inviteMember' : 'requestMembership';
		plugins.hooks.fire(`action:group.${hookName}`, {
			groupName: groupName,
			uids: uids,
		});
		return uids;
	}

	Groups.isInvited = async function (uids: string[], groupName: string) {
		return await checkInvitePending(uids, `group:${groupName}:invited`);
	};

	Groups.isPending = async function (uids: string[], groupName: string) {
		return await checkInvitePending(uids, `group:${groupName}:pending`);
	};

	async function checkInvitePending(uids: string | string[], set: any) {
		const isArray = Array.isArray(uids);
		uids = isArray ? uids as string[] : [uids] as string[]; 
		const checkUids = uids.filter((uid: string) => parseInt(uid, 10) > 0);
		const isMembers = await db.isSetMembers(set, checkUids);
		const map = _.zipObject(checkUids, isMembers);
		return isArray ? uids.map(uid => !!map[uid]) : !!map[uids[0]];
	}
};
