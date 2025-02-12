import { Meteor } from 'meteor/meteor';
import ldapjs from 'ldapjs';
import Bunyan from 'bunyan';

import { callbacks } from '../../callbacks/server';
import { settings } from '../../settings';
import { Logger } from '../../logger';

const logger = new Logger('LDAP');

export const connLogger = logger.section('Connection');
export const bindLogger = logger.section('Bind');
export const searchLogger = logger.section('Search');
export const authLogger = logger.section('Auth');

export default class LDAP {
	constructor() {
		this.ldapjs = ldapjs;

		this.connected = false;

		this.options = {
			host: settings.get('LDAP_Host'),
			port: settings.get('LDAP_Port'),
			Reconnect: settings.get('LDAP_Reconnect'),
			Internal_Log_Level: settings.get('LDAP_Internal_Log_Level'),
			timeout: settings.get('LDAP_Timeout'),
			connect_timeout: settings.get('LDAP_Connect_Timeout'),
			idle_timeout: settings.get('LDAP_Idle_Timeout'),
			encryption: settings.get('LDAP_Encryption'),
			ca_cert: settings.get('LDAP_CA_Cert'),
			reject_unauthorized: settings.get('LDAP_Reject_Unauthorized') || false,
			Authentication: settings.get('LDAP_Authentication'),
			Authentication_UserDN: settings.get('LDAP_Authentication_UserDN'),
			Authentication_Password: settings.get('LDAP_Authentication_Password'),
			BaseDN: settings.get('LDAP_BaseDN'),
			User_Search_Filter: settings.get('LDAP_User_Search_Filter'),
			User_Search_Scope: settings.get('LDAP_User_Search_Scope'),
			User_Search_Field: settings.get('LDAP_User_Search_Field'),
			Search_Page_Size: settings.get('LDAP_Search_Page_Size'),
			Search_Size_Limit: settings.get('LDAP_Search_Size_Limit'),
			group_filter_enabled: settings.get('LDAP_Group_Filter_Enable'),
			group_filter_object_class: settings.get('LDAP_Group_Filter_ObjectClass'),
			group_filter_group_id_attribute: settings.get('LDAP_Group_Filter_Group_Id_Attribute'),
			group_filter_group_member_attribute: settings.get('LDAP_Group_Filter_Group_Member_Attribute'),
			group_filter_group_member_format: settings.get('LDAP_Group_Filter_Group_Member_Format'),
			group_filter_group_name: settings.get('LDAP_Group_Filter_Group_Name'),
			find_user_after_login: settings.get('LDAP_Find_User_After_Login'),
		};
	}

	connectSync(...args) {
		if (!this._connectSync) {
			this._connectSync = Meteor.wrapAsync(this.connectAsync, this);
		}
		return this._connectSync(...args);
	}

	searchAllSync(...args) {
		if (!this._searchAllSync) {
			this._searchAllSync = Meteor.wrapAsync(this.searchAllAsync, this);
		}
		return this._searchAllSync(...args);
	}

	connectAsync(callback) {
		connLogger.info('Init setup');

		let replied = false;

		const connectionOptions = {
			url: `${ this.options.host }:${ this.options.port }`,
			timeout: this.options.timeout,
			connectTimeout: this.options.connect_timeout,
			idleTimeout: this.options.idle_timeout,
			reconnect: this.options.Reconnect,
		};

		if (this.options.Internal_Log_Level !== 'disabled') {
			connectionOptions.log = new Bunyan({
				name: 'ldapjs',
				component: 'client',
				stream: process.stderr,
				level: this.options.Internal_Log_Level,
			});
		}

		const tlsOptions = {
			rejectUnauthorized: this.options.reject_unauthorized,
		};

		if (this.options.ca_cert && this.options.ca_cert !== '') {
			// Split CA cert into array of strings
			const chainLines = settings.get('LDAP_CA_Cert').split('\n');
			let cert = [];
			const ca = [];
			chainLines.forEach((line) => {
				cert.push(line);
				if (line.match(/-END CERTIFICATE-/)) {
					ca.push(cert.join('\n'));
					cert = [];
				}
			});
			tlsOptions.ca = ca;
		}

		if (this.options.encryption === 'ssl') {
			connectionOptions.url = `ldaps://${ connectionOptions.url }`;
			connectionOptions.tlsOptions = tlsOptions;
		} else {
			connectionOptions.url = `ldap://${ connectionOptions.url }`;
		}

		connLogger.info({ msg: 'Connecting', url: connectionOptions.url });
		connLogger.debug({ msg: 'connectionOptions', connectionOptions });

		this.client = ldapjs.createClient(connectionOptions);

		this.bindSync = Meteor.wrapAsync(this.client.bind, this.client);

		this.client.on('error', (error) => {
			connLogger.error({ msg: 'connection', err: error });
			if (replied === false) {
				replied = true;
				callback(error, null);
			}
		});

		this.client.on('idle', () => {
			searchLogger.info('Idle');
			this.disconnect();
		});

		this.client.on('close', () => {
			searchLogger.info('Closed');
		});

		if (this.options.encryption === 'tls') {
			// Set host parameter for tls.connect which is used by ldapjs starttls. This shouldn't be needed in newer nodejs versions (e.g v5.6.0).
			// https://github.com/RocketChat/Rocket.Chat/issues/2035
			// https://github.com/mcavage/node-ldapjs/issues/349
			tlsOptions.host = this.options.host;

			connLogger.info('Starting TLS');
			connLogger.debug({ tlsOptions });

			this.client.starttls(tlsOptions, null, (error, response) => {
				if (error) {
					connLogger.error({ msg: 'TLS connection', err: error });
					if (replied === false) {
						replied = true;
						callback(error, null);
					}
					return;
				}

				connLogger.info('TLS connected');
				this.connected = true;
				if (replied === false) {
					replied = true;
					callback(null, response);
				}
			});
		} else {
			this.client.on('connect', (response) => {
				connLogger.info('LDAP connected');
				this.connected = true;
				if (replied === false) {
					replied = true;
					callback(null, response);
				}
			});
		}

		setTimeout(() => {
			if (replied === false) {
				connLogger.error({ msg: 'connection time out', connectTimeout: connectionOptions.connectTimeout });
				replied = true;
				callback(new Error('Timeout'));
			}
		}, connectionOptions.connectTimeout);
	}

	getUserFilter(username) {
		const filter = [];

		if (this.options.User_Search_Filter !== '') {
			if (this.options.User_Search_Filter[0] === '(') {
				filter.push(`${ this.options.User_Search_Filter }`);
			} else {
				filter.push(`(${ this.options.User_Search_Filter })`);
			}
		}

		const usernameFilter = this.options.User_Search_Field.split(',').map((item) => `(${ item }=${ username })`);

		if (usernameFilter.length === 0) {
			logger.error('LDAP_LDAP_User_Search_Field not defined');
		} else if (usernameFilter.length === 1) {
			filter.push(`${ usernameFilter[0] }`);
		} else {
			filter.push(`(|${ usernameFilter.join('') })`);
		}

		return `(&${ filter.join('') })`;
	}

	bindIfNecessary() {
		if (this.domainBinded === true) {
			return;
		}

		if (this.options.Authentication !== true) {
			return;
		}

		bindLogger.info({ msg: 'Binding UserDN', userDN: this.options.Authentication_UserDN });
		this.bindSync(this.options.Authentication_UserDN, this.options.Authentication_Password);
		this.domainBinded = true;
	}

	searchUsersSync(username, page) {
		this.bindIfNecessary();

		const searchOptions = {
			filter: this.getUserFilter(username),
			scope: this.options.User_Search_Scope || 'sub',
			sizeLimit: this.options.Search_Size_Limit,
		};

		if (this.options.Search_Page_Size > 0) {
			searchOptions.paged = {
				pageSize: this.options.Search_Page_Size,
				pagePause: !!page,
			};
		}

		searchLogger.info({ msg: 'Searching user', username });
		searchLogger.debug({ searchOptions, BaseDN: this.options.BaseDN });

		if (page) {
			return this.searchAllPaged(this.options.BaseDN, searchOptions, page);
		}

		return this.searchAllSync(this.options.BaseDN, searchOptions);
	}

	getUserByIdSync(id, attribute) {
		this.bindIfNecessary();

		const Unique_Identifier_Field = settings.get('LDAP_Unique_Identifier_Field').split(',');

		let filter;

		if (attribute) {
			filter = new this.ldapjs.filters.EqualityFilter({
				attribute,
				value: Buffer.from(id, 'hex'),
			});
		} else {
			const filters = [];
			Unique_Identifier_Field.forEach((item) => {
				filters.push(new this.ldapjs.filters.EqualityFilter({
					attribute: item,
					value: Buffer.from(id, 'hex'),
				}));
			});

			filter = new this.ldapjs.filters.OrFilter({ filters });
		}

		const searchOptions = {
			filter,
			scope: 'sub',
			attributes: ['*', '+'],
		};

		searchLogger.info({ msg: 'Searching by id', id });
		searchLogger.debug({ msg: 'search filter', filter: searchOptions.filter, BaseDN: this.options.BaseDN });

		const result = this.searchAllSync(this.options.BaseDN, searchOptions);

		if (!Array.isArray(result) || result.length === 0) {
			return;
		}

		if (result.length > 1) {
			searchLogger.error(`Search by id ${ id } returned ${ result.length } records`);
		}

		return result[0];
	}

	getUserByUsernameSync(username) {
		this.bindIfNecessary();

		const searchOptions = {
			filter: this.getUserFilter(username),
			scope: this.options.User_Search_Scope || 'sub',
		};

		searchLogger.info({ msg: 'Searching user', username });
		searchLogger.debug({ searchOptions, BaseDN: this.options.BaseDN });

		const result = this.searchAllSync(this.options.BaseDN, searchOptions);

		if (!Array.isArray(result) || result.length === 0) {
			return;
		}

		if (result.length > 1) {
			searchLogger.error(`Search by username ${ username } returned ${ result.length } records`);
		}

		return result[0];
	}

	isUserInGroup(username, userdn) {
		if (!this.options.group_filter_enabled) {
			return true;
		}

		const filter = ['(&'];

		if (this.options.group_filter_object_class !== '') {
			filter.push(`(objectclass=${ this.options.group_filter_object_class })`);
		}

		if (this.options.group_filter_group_member_attribute !== '') {
			filter.push(`(${ this.options.group_filter_group_member_attribute }=${ this.options.group_filter_group_member_format })`);
		}

		if (this.options.group_filter_group_id_attribute !== '') {
			filter.push(`(${ this.options.group_filter_group_id_attribute }=${ this.options.group_filter_group_name })`);
		}
		filter.push(')');

		const searchOptions = {
			filter: filter.join('').replace(/#{username}/g, username).replace(/#{userdn}/g, userdn),
			scope: 'sub',
		};

		searchLogger.debug({ msg: 'Group filter LDAP:', filter: searchOptions.filter });

		const result = this.searchAllSync(this.options.BaseDN, searchOptions);

		if (!Array.isArray(result) || result.length === 0) {
			return false;
		}
		return true;
	}

	extractLdapEntryData(entry) {
		const values = {
			_raw: entry.raw,
		};

		Object.keys(values._raw).forEach((key) => {
			const value = values._raw[key];

			if (!['thumbnailPhoto', 'jpegPhoto'].includes(key)) {
				if (value instanceof Buffer) {
					values[key] = value.toString();
				} else {
					values[key] = value;
				}
			}

			if (key === 'ou' && Array.isArray(value)) {
				value.forEach((item, index) => {
					if (item instanceof Buffer) {
						value[index] = item.toString();
					}
				});
			}
		});

		return values;
	}

	searchAllPaged(BaseDN, options, page) {
		this.bindIfNecessary();

		({ BaseDN, options } = callbacks.run('ldap.beforeSearchAll', { BaseDN, options }));

		const processPage = ({ entries, title, end, next }) => {
			searchLogger.info(title);
			// Force LDAP idle to wait the record processing
			this.client._updateIdle(true);
			page(null, entries, { end,
				next: () => {
				// Reset idle timer
					this.client._updateIdle();
					next && next();
				} });
		};

		this.client.search(BaseDN, options, (error, res) => {
			if (error) {
				searchLogger.error(error);
				page(error);
				return;
			}

			res.on('error', (error) => {
				searchLogger.error(error);
				page(error);
			});

			let entries = [];

			const internalPageSize = options.paged && options.paged.pageSize > 0 ? options.paged.pageSize * 2 : 500;

			res.on('searchEntry', (entry) => {
				entries.push(this.extractLdapEntryData(entry));

				if (entries.length >= internalPageSize) {
					processPage({
						entries,
						title: 'Internal Page',
						end: false,
					});
					entries = [];
				}
			});

			res.on('page', (result, next) => {
				if (!next) {
					this.client._updateIdle(true);
					processPage({
						entries,
						title: 'Final Page',
						end: true,
					});
					entries = [];
				} else if (entries.length) {
					processPage({
						entries,
						title: 'Page',
						end: false,
						next,
					});
					entries = [];
				}
			});

			res.on('end', () => {
				if (entries.length) {
					processPage({
						entries,
						title: 'Final Page',
						end: true,
					});
					entries = [];
				}
			});
		});
	}

	searchAllAsync(BaseDN, options, callback) {
		this.bindIfNecessary();

		({ BaseDN, options } = callbacks.run('ldap.beforeSearchAll', { BaseDN, options }));

		this.client.search(BaseDN, options, (error, res) => {
			if (error) {
				searchLogger.error(error);
				callback(error);
				return;
			}

			res.on('error', (error) => {
				searchLogger.error(error);
				callback(error);
			});

			const entries = [];

			res.on('searchEntry', (entry) => {
				entries.push(this.extractLdapEntryData(entry));
			});

			res.on('end', () => {
				searchLogger.info(`Search result count ${ entries.length }`);
				callback(null, entries);
			});
		});
	}

	authSync(dn, password) {
		authLogger.info({ msg: 'Authenticating', dn });

		try {
			this.bindSync(dn, password);
			if (this.options.find_user_after_login) {
				const searchOptions = {
					scope: this.options.User_Search_Scope || 'sub',
				};
				const result = this.searchAllSync(dn, searchOptions);
				if (result.length === 0) {
					authLogger.info({ msg: 'Bind successful but user was not found via search', dn, searchOptions });
					return false;
				}
			}
			authLogger.info({ msg: 'Authenticated', dn });
			return true;
		} catch (error) {
			authLogger.info({ msg: 'Not authenticated', dn });
			authLogger.debug(error);
			return false;
		}
	}

	disconnect() {
		this.connected = false;
		this.domainBinded = false;
		connLogger.info('Disconecting');
		this.client.unbind();
	}
}
