(function() {
/**
 *  {{#<block> <param>}}
 *      <innerTemplate>
 *  {{/<block> <param>}}
 */
var rBlock = /{{#([^}\s]+)\s+([^}\s]+)}}([\s\S]*?)({{\/\1\s+\2\s*}})|({{#[^}]+}})[\s\S]*?/g;

/**
 *  {{ <value> | <filter> | <filter>... }}
 */
var rPipe = /{{\s*([^}|\s]+)\s*((\|[^|}]+)+)}}/g;

/**
 * {{ <helper>:arg1:arg2... }}
 */
var rHelper = /{{\s*([^\s:]+)((:[^:]+)+)\s*}}/g;

/**
 * {{ <data-key> }}
 */
var rInterpolation = /{{([^}]+)}}/g;

var rTrim = /^\s+|\s+$/g;
var isStrict = true;
var toString = ({}).toString;
var identity = function(v) { return v; }

function map(iter, fn) {
    if (is(iter.map, 'function')) return iter.map(fn);
    return Object.keys(iter).map(function(key) {
        return fn(iter[key], key);
    });
}

function getParts(string, delimiter) {
    return string.split(delimiter).map(trim);
}

function is(o, type) {
    return toString.call(o).slice(8, -1).toLowerCase() === type;
}

function trim(s) {
    return s.replace(rTrim, '');
}

function convert(param, defaultValue) {
    if (!isNaN(+param)) {
        return +param;
    } else if (/^(['"]).*\1$/.test(param)) {
        return param.slice(1, -1);
    }

    return defaultValue;
}

/**
 * Crossbow.template('{{#each users}}<li>{{name}}</li>{{/each users}}', {users:[{name: 'John'}, {name: 'Alice'}]})
 * >>> <li>John</li><li>Alice</li>
 *
 * - innerTemplate: <li>{{name}}</li>
 * - argument: [{name: 'john'}, {name: 'alice'}]
 * - data: At the top level is the whole data
 *         inside a loop is the current item
 */
var blocks = {
    each: function(innerTemplate, argument, data) {
        return map(argument, function(item, key) {
            return template(innerTemplate, item, key);
        }).join('');
    },

    'if': function(innerTemplate, argument, data) {
        return argument ? template(innerTemplate, data) : '';
    },

    'unless': function(innerTemplate, argument, data) {
        return argument ? '' : template(innerTemplate, data);
    }
};

/**
 * Use the pipe character to apply a filter
 *  {{ <value> | filter1 | filter2... }} => filter2(filter1(<value>))
 * Arguments are separated by a colon
 *  {{ <value> | filter:2:"hola" }} => filter(value, 2, "hola")
 * Value can be of any type, please check it's type before performing any operation
 */
var filters = {
    at: at
};

/**
 * Arguments are separated by a colon
 * Crossbow.template('<div class="{{ if:error:"has-error":"ok" }}">', {error: 'Error'})
 * >>> <div class="has-error">
 */
var helpers = {
    'if': function(condition, ifValue, elseValue) {
        return condition ? ifValue : (elseValue === undefined ? '' : elseValue);
    },

    unless: function(condition, elseValue, ifValue) {
        return helpers.if(condition, ifValue, elseValue);
    }
};

/**
 * Get item from an Object or Array
 * returns an empty string if the item doesn't exists
 * template('{{ users.0.contact.email }}', {users: [{contact: {email: 'john@doe.com'}}]})
 * >>> john@doe.com
 */
function at(value, path) {
    if (value === undefined || value === null) return '';
    else if (value[path] !== undefined) return value[path];

    var keys = String(path).split('.');
    for (var i = 0; i < keys.length; i++) {
        if (value[keys[i]] === undefined) return '';
        value = value[keys[i]];
    }
    return value;
}

function template(tmpl, data, $key) {
    /**
     * Get value from template data
     * {{ :key }}  index inside a loop
     * {{ :item }} item inside a loop
     * {{ :value }} whole data at top level (or same as :item inside a loop)
     */
    function get(key) {
        switch (key) {
            case ':key': return $key === undefined ? '' : $key;
            case ':item': return data;
            case ':value': return data;
            default: return at(data, key);
        }
    }

    return tmpl.replace(rBlock, function(match, block, param, innerTmpl, close, unclosedBlock) {
        if (! block) throw new Error('Unclosed block ' + unclosedBlock);
        return replaceBlock(match, block, param, innerTmpl, get);
    }).replace(rPipe, function(match, startValue, pipes) {
        return replacePipe(match, startValue, pipes.slice(1), get);
    }).replace(rHelper, function(match, helperName, args) {
        return replaceHelper(match, helperName, args.slice(1), get);
    }).replace(rInterpolation, function(match, keys) {
        return replaceValue(keys, get);
    });
}

function replaceBlock(match, block, param, innerTmpl, get) {
    var fn = blocks[block];

    if (!is(fn, 'function')) {
        if (isStrict)
            throw new Error('Unknown block {{#' + block + ' ' + param + '}}');
        return '';
    }

    return fn(innerTmpl, get(param), get(':value'));
}

function replacePipe(match, param, pipes, get) {
    var startValue = getArg(get, param);
    var filters = getParts(pipes, '|').map(partial(toFilter, get));

    if (isStrict && getUnknownFilter(filters)) {
        throw new TypeError('Unknown filter [' + getUnknownFilter(filters).name + '] at ' + match);
    }

    return filters.reduce(function(value, filter) {
        return filter.fn.apply(null, [value].concat(filter.params));
    }, startValue);
}

function getUnknownFilter(_filters) {
    return _filters.find(function(filter) {
        return !filters.hasOwnProperty(filter.name);
    });
}

function toFilter(get, string) {
    var parts = getParts(string, ':');
    return {
        name: parts[0],
        fn: filters.hasOwnProperty(parts[0]) ? filters[parts[0]] : identity,
        params: parts.slice(1).map(partial(getArg, get))
    };
}

function replaceHelper(match, helperName, argList, get) {
    var helper = helpers.hasOwnProperty(helperName) && helpers[helperName];
    var args = getParts(argList, ':').map(partial(getArg, get));

    if (!is(helper, 'function')) {
        if (isStrict) {
            throw new Error('Unknown helper [' + helperName + '] at ' + match);
        }
        return '';
    }

    return helper.apply(null, args);
}

/**
 * Interpolate a single value
 * Use || to interpolate the first value that is not undefined
 * template('{{ user || error }}', {error: 'Not found'}) => 'Not found'
 */
function replaceValue(keys, get) {
    var ret = getParts(keys, '||').map(get).find(function(value) {
        return value !== undefined;
    });

    return ret !== undefined ? ret : '';
}

function getArg(get, arg){
    return convert(arg, get(arg));
}

function partial(fn) {
    var args = [null].concat([].slice.call(arguments, 1));
    return Function.bind.apply(fn, args);
}

function methodToFunction(method) {
    return Function.call.bind(method);
}

function addFunction(collection, name, fn) {
    collection[name] = fn;
}

function setStrict(v) {
    isStrict = !!v;
}

window.Crossbow = {
    template: template,
    addFilter: partial(addFunction, filters),
    addBlock:  partial(addFunction, blocks),
    addHelper: partial(addFunction, helpers),
    setStrict: setStrict,
    is: is,
    methodToFunction: methodToFunction
};
})();
